// Loopback webcam bridge for the iOS Simulator camera shim.
//
// The Simulator has no real camera, so the BotflowCameraShim dylib (injected
// into the app via DYLD_INSERT_LIBRARIES at launch) dials back to this server on
// 127.0.0.1 — the simulator shares the Mac's loopback — and pulls JPEG frames
// that originate from the browser's webcam:
//
//   browser getUserMedia → controller → host (controller-client binary) →
//   CameraServer.pushFrame() → shim socket → swizzled AVCaptureSession
//
// This server is loopback-only and never exposed off the host. Each session
// mints a per-session capability token (mirroring the controller's streamToken)
// that the shim must present on connect, so a stray local process can't attach
// to another session's camera feed.

import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { log, warn } from './log.js';

export interface CameraInjection {
  /** Absolute path to the shim dylib for SIMCTL_CHILD_DYLD_INSERT_LIBRARIES. */
  dyldPath: string;
  /** ws://127.0.0.1:<port>/camera?session=…&token=… for the shim to dial. */
  cameraUrl: string;
}

type CameraRequestListener = (sessionId: string, active: boolean) => void;

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class CameraServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  /** sessionId → capability token expected from the shim. */
  private tokens = new Map<string, string>();
  /** sessionId → connected shim socket (one app per session). */
  private clients = new Map<string, WebSocket>();
  private listeners = new Set<CameraRequestListener>();

  constructor(
    private readonly host = '127.0.0.1',
    private readonly desiredPort = parseInt(process.env.BOTFLOW_CAMERA_PORT ?? '8090', 10),
  ) {}

  async start(): Promise<void> {
    if (this.wss) return;
    await new Promise<void>((resolve, reject) => {
      const http = createServer();
      const wss = new WebSocketServer({ server: http, path: '/camera' });
      wss.on('connection', (ws, req) => this.onConnection(ws, req.url ?? ''));
      http.on('error', reject);
      // Bind to loopback only — never reachable off-host.
      http.listen(this.desiredPort, this.host, () => {
        const addr = http.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.desiredPort;
        this.http = http;
        this.wss = wss;
        log(`Camera server listening on ws://${this.host}:${this.port}/camera`);
        resolve();
      });
    });
  }

  onCameraRequest(listener: CameraRequestListener): void {
    this.listeners.add(listener);
  }

  private emitCameraRequest(sessionId: string, active: boolean): void {
    for (const l of this.listeners) {
      try {
        l(sessionId, active);
      } catch (e) {
        warn(`camera request listener threw: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Mint + register a capability token for a session and return the env values
   * needed to inject the shim at launch. Returns null when the shim dylib isn't
   * available on this host (camera feature simply stays off; launch proceeds).
   */
  prepareInjection(sessionId: string, token: string): CameraInjection | null {
    const dyldPath = resolveShimDylib();
    if (!dyldPath) return null;
    if (!this.wss) {
      warn('prepareInjection called before camera server started');
      return null;
    }
    this.tokens.set(sessionId, token);
    const cameraUrl = `ws://${this.host}:${this.port}/camera?session=${encodeURIComponent(
      sessionId,
    )}&token=${encodeURIComponent(token)}`;
    return { dyldPath, cameraUrl };
  }

  /** Forget a session's token + drop any connected shim. Called on session stop. */
  releaseSession(sessionId: string): void {
    this.tokens.delete(sessionId);
    const ws = this.clients.get(sessionId);
    if (ws) {
      this.clients.delete(sessionId);
      try {
        ws.close(1000, 'session ended');
      } catch {
        /* ignore */
      }
    }
  }

  /** Send one webcam JPEG frame to the session's shim. Best-effort, latest-wins. */
  pushFrame(sessionId: string, _timestampMs: number, jpeg: Buffer): void {
    const ws = this.clients.get(sessionId);
    if (!ws || ws.readyState !== ws.OPEN) return;
    // Backpressure guard: if the shim can't keep up, drop rather than buffer —
    // a stale webcam frame is worthless.
    if (ws.bufferedAmount > 4 * 1024 * 1024) return;
    try {
      ws.send(jpeg, { binary: true });
    } catch {
      /* ignore */
    }
  }

  private onConnection(ws: WebSocket, url: string): void {
    const parsed = new URL(url, `http://${this.host}`);
    const sessionId = parsed.searchParams.get('session') ?? '';
    const token = parsed.searchParams.get('token') ?? '';
    const expected = this.tokens.get(sessionId);
    if (!expected || !token || !tokensMatch(expected, token)) {
      warn(`Rejected shim camera connection for ${sessionId.slice(0, 8)}: bad/absent token`);
      try {
        ws.close(4401, 'unauthorized');
      } catch {
        /* ignore */
      }
      return;
    }
    // Replace any prior connection for this session (rebuild relaunches the app).
    const prior = this.clients.get(sessionId);
    if (prior && prior !== ws) {
      try {
        prior.close(1000, 'replaced');
      } catch {
        /* ignore */
      }
    }
    this.clients.set(sessionId, ws);
    log(`Shim camera attached for ${sessionId.slice(0, 8)}`);
    this.emitCameraRequest(sessionId, true);

    ws.on('close', () => {
      if (this.clients.get(sessionId) === ws) {
        this.clients.delete(sessionId);
        this.emitCameraRequest(sessionId, false);
        log(`Shim camera detached for ${sessionId.slice(0, 8)}`);
      }
    });
    ws.on('error', () => {
      /* close handler does cleanup */
    });
  }

  stop(): void {
    for (const ws of this.clients.values()) {
      try {
        ws.close(1000, 'shutdown');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.tokens.clear();
    this.wss?.close();
    this.http?.close();
    this.wss = null;
    this.http = null;
  }
}

/**
 * Locate the prebuilt simulator dylib. Override with BOTFLOW_CAMERA_SHIM_DYLIB;
 * otherwise look in the host-agent's shipped assets. Returns null if absent so
 * the host degrades gracefully (launch without camera injection).
 */
function resolveShimDylib(): string | null {
  const override = process.env.BOTFLOW_CAMERA_SHIM_DYLIB;
  const candidates = [
    override,
    new URL('../assets/BotflowCameraShim.dylib', import.meta.url).pathname,
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}
