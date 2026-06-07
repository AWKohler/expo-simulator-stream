import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BuildDiagnostic, LogStream } from '@sim/shared';
import { execAsync } from './util.js';
import { log, warn } from './log.js';
import { parseProjectYml, type ProjectInfo } from './project-yml.js';
import { extractDiagnostics, sanitizeLine } from './build-diagnostics.js';
import { ensureOrientationShim } from './orientation-shim.js';

const BUILDS_ROOT = path.join(tmpdir(), 'sim-builds');

export interface BuildResult {
  appBundlePath: string;
  scheme: string;
  bundleId: string;
  durationMs: number;
  /** Authoritative structured diagnostics extracted from the .xcresult bundle.
   * Empty array on success with no warnings, or when extraction failed. */
  diagnostics: BuildDiagnostic[];
}

export interface DeviceBuildResult {
  ipaPath: string;
  appBundlePath: string;
  scheme: string;
  bundleId: string;
  durationMs: number;
  diagnostics: BuildDiagnostic[];
  unsigned: true;
}

export interface BuildOptions {
  sessionId: string;
  tarballBuf: Buffer;
  hints?: Partial<ProjectInfo>;
  onLog: (line: string, stream: LogStream) => void;
}

export interface DeviceBuildOptions {
  buildId: string;
  tarballBuf: Buffer;
  hints?: Partial<ProjectInfo>;
  onLog?: (line: string, stream: LogStream) => void;
}

export class BuildAborted extends Error {
  constructor() {
    super('build aborted');
  }
}

/**
 * Untar the project into a per-session workdir, parse `project.yml`, then run
 * `xcodebuild` and stream stdout/stderr line-by-line via `onLog`. Resolves with
 * the absolute path to the built `.app` bundle on success.
 *
 * The returned handle exposes `cancel()` so a stale build can be killed if the
 * user clicks Refresh while a build is in flight.
 */
export interface BuildHandle {
  done: Promise<BuildResult>;
  cancel: () => void;
}

export interface DeviceBuildHandle {
  done: Promise<DeviceBuildResult>;
  cancel: () => void;
}

export function runBuild(options: BuildOptions): BuildHandle {
  const { sessionId, tarballBuf, hints, onLog } = options;
  const workdir = path.join(BUILDS_ROOT, sessionId);
  let proc: ChildProcess | null = null;
  let cancelled = false;

  const cancel = (): void => {
    cancelled = true;
    if (proc && !proc.killed) proc.kill('SIGTERM');
  };

  const done = (async (): Promise<BuildResult> => {
    if (existsSync(workdir)) {
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch (e) {
        warn(`Could not clean workdir ${workdir}: ${(e as Error).message}`);
      }
    }
    mkdirSync(workdir, { recursive: true });

    // ── 1. Extract tarball via tar -xz piped from stdin ──
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', '-', '-C', workdir]);
      let stderr = '';
      tar.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      tar.on('exit', (code) => {
        if (cancelled) return reject(new BuildAborted());
        if (code === 0) return resolve();
        reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
      });
      tar.on('error', reject);
      tar.stdin.write(tarballBuf);
      tar.stdin.end();
    });

    if (cancelled) throw new BuildAborted();

    // ── 2. Parse project.yml ──
    const project = parseProjectYml(workdir, hints);
    log(`Project: scheme=${project.scheme} bundleId=${project.bundleId}`);

    // ── 2b. Regenerate xcodeproj from project.yml if possible ──
    // project.yml is the source of truth for swift-template projects. If the
    // user renamed the project there (MyApp → TodoApp) the on-disk xcodeproj
    // is stale until xcodegen runs. Without this step we'd build the OLD app
    // (MyApp.app) and then fail to launch the NEW bundle id (com.botflow.todoapp).
    const projectYmlPath = path.join(workdir, 'project.yml');
    if (existsSync(projectYmlPath)) {
      const probe = await execAsync('command -v xcodegen', { timeoutMs: 5_000 });
      if (probe.code === 0 && probe.stdout.trim()) {
        const gen = await execAsync(`cd "${workdir}" && xcodegen generate`, {
          timeoutMs: 60_000,
        });
        if (gen.code !== 0) {
          // Non-fatal — fall through to the glob fallback below. If the
          // .xcodeproj already exists we can still build with it.
          onLog(
            `xcodegen failed (${gen.code}): ${(gen.stderr || gen.stdout).split('\n')[0]}`,
            'stderr',
          );
        } else {
          onLog(`xcodegen regenerated project from project.yml`, 'stdout');
        }
      } else {
        onLog(
          'project.yml present but xcodegen not installed on host — using stale .xcodeproj',
          'stderr',
        );
      }
    }

    // ── 3. Locate the xcodeproj (named after the scheme by convention) ──
    const xcodeproj = path.join(workdir, `${project.scheme}.xcodeproj`);
    if (!existsSync(xcodeproj)) {
      // Fall back: glob for any .xcodeproj in the workdir root.
      const glob = await execAsync(`ls -d "${workdir}"/*.xcodeproj 2>/dev/null | head -1`);
      const found = glob.stdout.trim();
      if (!found) {
        throw new Error(
          `No .xcodeproj found in workdir (expected ${project.scheme}.xcodeproj).`,
        );
      }
      // Re-derive scheme from the basename. NOTE: bundleId stays as parsed
      // from project.yml — it may not match the .app we're about to build.
      // We reconcile that after the build by reading the .app's Info.plist.
      project.scheme = path.basename(found, '.xcodeproj');
    }

    const derivedData = path.join(workdir, 'build');
    const startedAt = Date.now();

    // ── 4. Run xcodebuild, streaming output line-by-line ──
    // -resultBundlePath writes a .xcresult bundle we parse post-exit for
    // authoritative structured diagnostics. Must not pre-exist or xcodebuild
    // refuses to overwrite.
    const resultBundlePath = path.join(workdir, 'result.xcresult');
    try {
      rmSync(resultBundlePath, { recursive: true, force: true });
    } catch {
      /* fine */
    }

    let xcExitCode: number | null = null;
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-project',
        path.join(workdir, `${project.scheme}.xcodeproj`),
        '-scheme',
        project.scheme,
        '-sdk',
        'iphonesimulator',
        '-derivedDataPath',
        derivedData,
        '-resultBundlePath',
        resultBundlePath,
        // Apple Silicon hosts only need the arm64 simulator slice. Without
        // these, xcodebuild uses ARCHS_STANDARD for iphonesimulator which
        // also tries x86_64 — wasted time and a frequent source of arch-
        // specific build flakes (binary-only arm64 SwiftPM deps, etc.).
        'ONLY_ACTIVE_ARCH=YES',
        'ARCHS=arm64',
        'CODE_SIGN_IDENTITY=',
        'CODE_SIGNING_REQUIRED=NO',
        'CODE_SIGNING_ALLOWED=NO',
        // Preview-only orientation enablement: let Botflow's orientation toggle
        // rotate ANY project — even ones scaffolded before the template gained a
        // supported-orientations list. These override the generated Info.plist
        // (only effective with GENERATE_INFOPLIST_FILE=YES, which the templates
        // use). UIRequiresFullScreen is required so iPadOS doesn't reject the
        // geometry change in windowed/Stage-Manager mode. This affects the
        // simulator preview build only — never the user's device/App Store build.
        'INFOPLIST_KEY_UIRequiresFullScreen=YES',
        'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone=UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight',
        'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad=UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight',
        'build',
      ];
      log(`xcodebuild ${args.join(' ')}`);
      proc = spawn('xcodebuild', args, { cwd: workdir });

      // Every line passes through `sanitizeLine` BEFORE reaching `onLog`.
      // This is the single chokepoint that strips workdir/session-id, Xcode
      // paths, /Users/<name>/, and drops destination-enumeration blocks —
      // so nothing sensitive ever crosses the wire, even in the raw log
      // disclosure on the browser side.
      const wireLineStream = (
        readable: NodeJS.ReadableStream | null,
        stream: LogStream,
      ): void => {
        if (!readable) return;
        let buf = '';
        const emit = (raw: string): void => {
          const cleaned = sanitizeLine(raw, workdir);
          if (cleaned && cleaned.length > 0) onLog(cleaned, stream);
        };
        readable.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) if (line.length > 0) emit(line);
        });
        readable.on('end', () => {
          if (buf.length > 0) emit(buf);
        });
      };
      wireLineStream(proc.stdout, 'stdout');
      wireLineStream(proc.stderr, 'stderr');

      proc.on('exit', (code) => {
        xcExitCode = code;
        if (cancelled) return reject(new BuildAborted());
        // Resolve regardless of exit code so we can extract diagnostics
        // either way; we re-check `code` below and throw the build error
        // *after* diagnostics are pulled.
        resolve();
      });
      proc.on('error', reject);
    });

    // Pull authoritative structured diagnostics from the xcresult bundle.
    // Best-effort: extractDiagnostics returns [] on any failure and must
    // never throw. We pull on both success (for warnings) and failure.
    const diagnostics = await extractDiagnostics(resultBundlePath, workdir);

    if (xcExitCode !== 0) {
      const err = new Error(`xcodebuild exited ${xcExitCode}`);
      // Attach diagnostics so the caller can surface them on a failed build.
      (err as Error & { diagnostics?: BuildDiagnostic[] }).diagnostics = diagnostics;
      throw err;
    }

    const appBundlePath = path.join(
      derivedData,
      'Build/Products/Debug-iphonesimulator',
      `${project.scheme}.app`,
    );
    if (!existsSync(appBundlePath)) {
      throw new Error(`Build succeeded but .app missing at ${appBundlePath}`);
    }

    // Read the *actual* bundle id from the built .app's Info.plist — the
    // single source of truth for what simctl will see after `install`. If it
    // diverges from project.yml (stale xcodeproj, no xcodegen, hand-edits),
    // we trust the .app and launch that.
    const installedBundleId = await readAppBundleId(appBundlePath);
    if (installedBundleId && installedBundleId !== project.bundleId) {
      log(
        `bundleId mismatch: project.yml says ${project.bundleId}, ` +
          `.app Info.plist says ${installedBundleId} — using ${installedBundleId} for launch`,
      );
      project.bundleId = installedBundleId;
    }

    return {
      appBundlePath,
      scheme: project.scheme,
      bundleId: project.bundleId,
      durationMs: Date.now() - startedAt,
      diagnostics,
    };
  })();

  return { done, cancel };
}

/**
 * Build an unsigned physical-device IPA. This is the cloud side of Botflow's
 * local companion flow:
 *
 *   cloud Mac: compile Swift project for iphoneos → unsigned .ipa
 *   user Mac: Botflow Companion signs/provisions/installs with user's Apple ID
 *
 * This deliberately does NOT touch simulator sessions, boot a simulator, or
 * invoke simctl. The output is an installable IPA-shaped zip with Payload/*.app;
 * AltSign/AltServer will replace signing assets locally before device install.
 */
export function runDeviceBuild(options: DeviceBuildOptions): DeviceBuildHandle {
  const { buildId, tarballBuf, hints, onLog = () => undefined } = options;
  const workdir = path.join(BUILDS_ROOT, `device-${buildId}`);
  let proc: ChildProcess | null = null;
  let cancelled = false;

  const cancel = (): void => {
    cancelled = true;
    if (proc && !proc.killed) proc.kill('SIGTERM');
  };

  const done = (async (): Promise<DeviceBuildResult> => {
    if (existsSync(workdir)) {
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch (e) {
        warn(`Could not clean device build workdir ${workdir}: ${(e as Error).message}`);
      }
    }
    mkdirSync(workdir, { recursive: true });

    await new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', '-', '-C', workdir]);
      let stderr = '';
      tar.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      tar.on('exit', (code) => {
        if (cancelled) return reject(new BuildAborted());
        if (code === 0) return resolve();
        reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
      });
      tar.on('error', reject);
      tar.stdin.write(tarballBuf);
      tar.stdin.end();
    });

    if (cancelled) throw new BuildAborted();

    const project = parseProjectYml(workdir, hints);
    log(`Device build: scheme=${project.scheme} bundleId=${project.bundleId}`);

    const projectYmlPath = path.join(workdir, 'project.yml');
    if (existsSync(projectYmlPath)) {
      const probe = await execAsync('command -v xcodegen', { timeoutMs: 5_000 });
      if (probe.code === 0 && probe.stdout.trim()) {
        const gen = await execAsync(`cd "${workdir}" && xcodegen generate`, {
          timeoutMs: 60_000,
        });
        if (gen.code !== 0) {
          onLog(
            `xcodegen failed (${gen.code}): ${(gen.stderr || gen.stdout).split('\n')[0]}`,
            'stderr',
          );
        } else {
          onLog('xcodegen regenerated project from project.yml', 'stdout');
        }
      } else {
        onLog(
          'project.yml present but xcodegen not installed on host — using stale .xcodeproj',
          'stderr',
        );
      }
    }

    const xcodeproj = path.join(workdir, `${project.scheme}.xcodeproj`);
    if (!existsSync(xcodeproj)) {
      const glob = await execAsync(`ls -d "${workdir}"/*.xcodeproj 2>/dev/null | head -1`);
      const found = glob.stdout.trim();
      if (!found) {
        throw new Error(
          `No .xcodeproj found in device build workdir (expected ${project.scheme}.xcodeproj).`,
        );
      }
      project.scheme = path.basename(found, '.xcodeproj');
    }

    const derivedData = path.join(workdir, 'build');
    const resultBundlePath = path.join(workdir, 'device-result.xcresult');
    try {
      rmSync(resultBundlePath, { recursive: true, force: true });
    } catch {
      /* fine */
    }

    const startedAt = Date.now();
    let xcExitCode: number | null = null;
    await new Promise<void>((resolve, reject) => {
      const args = [
        '-project',
        path.join(workdir, `${project.scheme}.xcodeproj`),
        '-scheme',
        project.scheme,
        '-sdk',
        'iphoneos',
        '-destination',
        'generic/platform=iOS',
        '-derivedDataPath',
        derivedData,
        '-resultBundlePath',
        resultBundlePath,
        'CODE_SIGN_IDENTITY=',
        'CODE_SIGNING_REQUIRED=NO',
        'CODE_SIGNING_ALLOWED=NO',
        // Xcode 16 Debug builds otherwise split into a thin launcher + a
        // <App>.debug.dylib (and __preview.dylib) that only run under Xcode's
        // harness — installed standalone they launch then crash instantly.
        // Disable both so the device IPA is a normal self-contained binary.
        'ENABLE_DEBUG_DYLIB=NO',
        'ENABLE_PREVIEWS=NO',
        'build',
      ];
      log(`device xcodebuild ${args.join(' ')}`);
      proc = spawn('xcodebuild', args, { cwd: workdir });

      const wireLineStream = (
        readable: NodeJS.ReadableStream | null,
        stream: LogStream,
      ): void => {
        if (!readable) return;
        let buf = '';
        const emit = (raw: string): void => {
          const cleaned = sanitizeLine(raw, workdir);
          if (cleaned && cleaned.length > 0) onLog(cleaned, stream);
        };
        readable.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) if (line.length > 0) emit(line);
        });
        readable.on('end', () => {
          if (buf.length > 0) emit(buf);
        });
      };
      wireLineStream(proc.stdout, 'stdout');
      wireLineStream(proc.stderr, 'stderr');

      proc.on('exit', (code) => {
        xcExitCode = code;
        if (cancelled) return reject(new BuildAborted());
        resolve();
      });
      proc.on('error', reject);
    });

    const diagnostics = await extractDiagnostics(resultBundlePath, workdir);
    if (xcExitCode !== 0) {
      const err = new Error(`xcodebuild exited ${xcExitCode}`);
      (err as Error & { diagnostics?: BuildDiagnostic[] }).diagnostics = diagnostics;
      throw err;
    }

    const appBundlePath = path.join(
      derivedData,
      'Build/Products/Debug-iphoneos',
      `${project.scheme}.app`,
    );
    if (!existsSync(appBundlePath)) {
      throw new Error(`Device build succeeded but .app missing at ${appBundlePath}`);
    }

    const installedBundleId = await readAppBundleId(appBundlePath);
    if (installedBundleId && installedBundleId !== project.bundleId) {
      log(
        `device bundleId mismatch: project.yml says ${project.bundleId}, ` +
          `.app Info.plist says ${installedBundleId} — using ${installedBundleId}`,
      );
      project.bundleId = installedBundleId;
    }

    const ipaRoot = path.join(workdir, 'ipa');
    const payloadDir = path.join(ipaRoot, 'Payload');
    const payloadAppPath = path.join(payloadDir, `${project.scheme}.app`);
    mkdirSync(payloadDir, { recursive: true });

    const copy = await execAsync(
      `/usr/bin/ditto "${appBundlePath}" "${payloadAppPath}"`,
      { timeoutMs: 60_000 },
    );
    if (copy.code !== 0) {
      throw new Error(`ditto app copy failed: ${copy.stderr || copy.stdout}`);
    }

    const ipaPath = path.join(workdir, `${project.scheme}.ipa`);
    const zip = await execAsync(
      `/usr/bin/ditto -c -k --norsrc --keepParent "Payload" "${ipaPath}"`,
      { timeoutMs: 60_000, cwd: ipaRoot },
    );
    if (zip.code !== 0) {
      throw new Error(`IPA packaging failed: ${zip.stderr || zip.stdout}`);
    }

    return {
      ipaPath,
      appBundlePath,
      scheme: project.scheme,
      bundleId: project.bundleId,
      durationMs: Date.now() - startedAt,
      diagnostics,
      unsigned: true,
    };
  })();

  return { done, cancel };
}

/**
 * Read CFBundleIdentifier from a built .app's Info.plist via `plutil`.
 * Handles both binary and XML plist formats. Returns null on any failure
 * (caller falls back to whatever bundleId it parsed from project.yml).
 */
async function readAppBundleId(appBundlePath: string): Promise<string | null> {
  const plist = path.join(appBundlePath, 'Info.plist');
  if (!existsSync(plist)) return null;
  const res = await execAsync(
    `/usr/bin/plutil -extract CFBundleIdentifier raw -o - -- "${plist}"`,
    { timeoutMs: 5_000 },
  );
  if (res.code !== 0) return null;
  const out = res.stdout.trim();
  return out.length > 0 ? out : null;
}

export interface LaunchCameraInjection {
  /** Absolute path to the BotflowCameraShim simulator dylib. */
  dyldPath: string;
  /** ws://127.0.0.1:<port>/camera?session=…&token=… for the shim to dial. */
  cameraUrl: string;
}

export async function installAndLaunch(
  udid: string,
  appBundlePath: string,
  bundleId: string,
  camera?: LaunchCameraInjection | null,
): Promise<void> {
  const install = await execAsync(`xcrun simctl install ${udid} "${appBundlePath}"`, {
    timeoutMs: 60_000,
  });
  if (install.code !== 0) {
    throw new Error(`simctl install failed: ${install.stderr || install.stdout}`);
  }
  // `simctl launch` forwards SIMCTL_CHILD_*-prefixed env vars to the app process.
  // We use that to inject our shims (DYLD_INSERT_LIBRARIES) without touching the
  // user's project:
  //   • the orientation shim — ALWAYS injected — registers Darwin observers so
  //     Botflow's orientation toggle can rotate any app (even pre-observer ones);
  //   • the camera shim — when a camera session is active — vends webcam frames.
  // DYLD_INSERT_LIBRARIES is colon-separated, so both can ride together.
  const insertLibs: string[] = [];
  try {
    insertLibs.push(await ensureOrientationShim());
  } catch (e) {
    warn(`orientation shim unavailable (rotation disabled for this launch): ${(e as Error).message}`);
  }
  if (camera) insertLibs.push(camera.dyldPath);
  const env: NodeJS.ProcessEnv | undefined =
    insertLibs.length > 0
      ? {
          SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: insertLibs.join(':'),
          ...(camera ? { SIMCTL_CHILD_BOTFLOW_CAMERA_URL: camera.cameraUrl } : {}),
        }
      : undefined;
  // simctl launch returns immediately with PID; use --terminate-running-process so a
  // rebuild replaces the previous process cleanly.
  const launch = await execAsync(
    `xcrun simctl launch --terminate-running-process ${udid} ${bundleId}`,
    { timeoutMs: 15_000, env },
  );
  if (launch.code !== 0) {
    throw new Error(`simctl launch failed: ${launch.stderr || launch.stdout}`);
  }
}
