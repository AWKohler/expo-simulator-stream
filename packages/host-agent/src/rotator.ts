import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, warn } from './log.js';

// Signed .app helper that performs the GUI rotate (⌘→) the host-agent's `node`
// process can't (macOS grants Accessibility to .app bundles, not raw binaries).
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(PKG_ROOT, 'native', 'rotator', 'main.swift');
const PLIST = path.join(PKG_ROOT, 'native', 'rotator', 'Info.plist');
const APP = path.join(PKG_ROOT, 'native', 'rotator', 'build', 'BotflowRotator.app');
export const ROTATOR_APP = APP;
export const ROTATOR_BIN = path.join(APP, 'Contents', 'MacOS', 'BotflowRotator');

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      else resolve();
    });
  });
}

/**
 * Build + ad-hoc-sign BotflowRotator.app if missing/stale. The ad-hoc signature
 * gives it a stable bundle identity (io.botflow.rotator) that the operator
 * grants Accessibility to once. Rebuilt only when the source changes (a rebuild
 * changes the cdhash and would invalidate the grant).
 */
export async function ensureRotator(): Promise<void> {
  const fresh = existsSync(ROTATOR_BIN) && statSync(ROTATOR_BIN).mtimeMs >= statSync(SRC).mtimeMs;
  if (fresh) return;
  const macos = path.join(APP, 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  await run('swiftc', ['-O', SRC, '-o', ROTATOR_BIN, '-framework', 'Cocoa', '-framework', 'ApplicationServices']);
  copyFileSync(PLIST, path.join(APP, 'Contents', 'Info.plist'));
  await run('codesign', ['--force', '--identifier', 'io.botflow.rotator', '--sign', '-', APP]);
  log(`BotflowRotator.app built + signed: ${APP}`);
  warn(
    `Rotation requires a one-time grant: System Settings ▸ Privacy & Security ▸ ` +
      `Accessibility ▸ + ▸ ${APP}`,
  );
}
