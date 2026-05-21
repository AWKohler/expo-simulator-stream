// WebSocket upgrade router. Two endpoints:
//   /ws/host                — Host Agent ↔ Controller (auth via HOST_TOKEN env)
//   /ws/session/:sessionId  — Browser ↔ Controller (sessionId is the bearer)

import type { Server as HTTPServer, IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  BrowserToServer,
  HostToController,
  safeParse,
} from '@sim/shared';
import type { HostRecord, Orchestrator } from '../orchestrator.js';
import type { SessionProxy } from '../proxy.js';
import { log, warn } from '../log.js';

interface AttachOptions {
  hostToken: string;
}

export function attachWS(
  http: HTTPServer,
  orch: Orchestrator,
  proxy: SessionProxy,
  options: AttachOptions,
): void {
  const wssHost = new WebSocketServer({ noServer: true });
  const wssSession = new WebSocketServer({ noServer: true });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/ws/host') {
      wssHost.handleUpgrade(req, socket, head, (ws) => {
        wssHost.emit('connection', ws, req);
      });
      return;
    }
    const m = /^\/ws\/session\/([0-9a-fA-F-]+)$/.exec(url.pathname);
    if (m) {
      const sessionId = m[1];
      wssSession.handleUpgrade(req, socket, head, (ws) => {
        wssSession.emit('connection', ws, req, sessionId);
      });
      return;
    }
    socket.destroy();
  });

  wssHost.on('connection', (ws: WebSocket, req: IncomingMessage) =>
    handleHostConnection(ws, req, orch, proxy, options),
  );
  wssSession.on('connection', (ws: WebSocket, _req: IncomingMessage, sessionId: string) =>
    handleSessionConnection(ws, sessionId, orch, proxy),
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Host Agent connection
// ──────────────────────────────────────────────────────────────────────────────
function handleHostConnection(
  ws: WebSocket,
  _req: IncomingMessage,
  orch: Orchestrator,
  proxy: SessionProxy,
  options: AttachOptions,
): void {
  let registeredHostId: string | null = null;
  let registeredHostRecord: HostRecord | null = null;

  const close = (reason: string, code = 1008): void => {
    try {
      ws.close(code, reason);
    } catch {
      /* ignore */
    }
  };

  ws.on('message', (raw) => {
    const data = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (Buffer.isBuffer(data) && data.length > 0 && data[0] === 1) {
      handleHostBinary(proxy, data);
      return;
    }
    const msg = safeParse(HostToController, data);
    if (!msg) {
      warn('Invalid host message');
      return;
    }

    // Hello must come first.
    if (!registeredHostId) {
      if (msg.type !== 'hello') {
        warn('Host did not greet first; closing.');
        close('hello required', 1008);
        return;
      }
      if (msg.hostToken !== options.hostToken) {
        warn(`Bad host token for ${msg.hostId}`);
        close('bad token', 4401);
        return;
      }
      registeredHostId = msg.hostId;
      const record: HostRecord = {
        hostId: msg.hostId,
        slots: msg.capacity.slots,
        deviceModels: msg.capacity.deviceModels,
        resources: msg.resources,
        activeSessionIds: new Set(),
        lastHeartbeat: Date.now(),
        send: (m) => ws.send(JSON.stringify(m)),
        close: () => ws.close(1000, 'host replaced'),
      };
      registeredHostRecord = record;
      orch.registerHost(record);
      log(`Host ${msg.hostId} attached`);
      return;
    }

    switch (msg.type) {
      case 'heartbeat':
        orch.recordHeartbeat(registeredHostId, msg.activeSessions, msg.resources);
        break;
      case 'session_event':
        handleSessionEvent(orch, proxy, msg);
        break;
      case 'session_frame':
        proxy.pushFrame(msg.sessionId, msg.jpegBase64);
        break;
      case 'video_config':
        proxy.pushVideoConfig(msg.sessionId, {
          codec: msg.codec,
          width: msg.width,
          height: msg.height,
          fps: msg.fps,
          bitrate: msg.bitrate,
          format: msg.format,
        });
        break;
      case 'host_status':
        if (msg.sessionId) proxy.pushStatus(msg.sessionId, msg.message);
        break;
      case 'build_event':
        handleBuildEvent(orch, proxy, msg);
        break;
      case 'hello':
        // Duplicate hello — ignore.
        break;
      case 'pong':
        break;
    }
  });

  ws.on('close', () => {
    if (registeredHostId && registeredHostRecord) {
      orch.unregisterHost(registeredHostId, registeredHostRecord);
    }
  });

  ws.on('error', (e) => warn(`Host WS error: ${(e as Error).message}`));
}

function handleHostBinary(proxy: SessionProxy, data: Buffer): void {
  if (data.length < 12) return;
  const flags = data.readUInt8(1);
  const sidLen = data.readUInt16BE(2);
  const timestampMs = Number(data.readBigUInt64BE(4));
  if (sidLen <= 0 || data.length < 12 + sidLen) return;
  const sessionId = data.subarray(12, 12 + sidLen).toString('utf8');
  const payload = data.subarray(12 + sidLen);
  if (payload.length === 0) return;
  proxy.pushVideoChunk(sessionId, timestampMs, (flags & 1) === 1, payload);
}

function handleBuildEvent(
  orch: Orchestrator,
  proxy: SessionProxy,
  msg: Extract<ReturnType<typeof HostToController.parse>, { type: 'build_event' }>,
): void {
  switch (msg.event) {
    case 'started':
      orch.markBuilding(msg.sessionId);
      proxy.updateState(msg.sessionId, 'building');
      proxy.pushBuildStatus(msg.sessionId, { state: 'started' });
      break;
    case 'log':
      if (msg.line !== undefined) {
        proxy.pushBuildLog(msg.sessionId, msg.line, msg.stream ?? 'stdout');
      }
      break;
    case 'diagnostic':
      // Live incremental issue parsed from a streamed log line.
      if (msg.diagnostic) {
        proxy.pushBuildDiagnostics(msg.sessionId, [msg.diagnostic], false);
      }
      break;
    case 'succeeded':
      // Authoritative xcresult set: replace whatever live diagnostics arrived.
      if (msg.diagnostics) {
        proxy.pushBuildDiagnostics(msg.sessionId, msg.diagnostics, true);
      }
      proxy.pushBuildStatus(msg.sessionId, {
        state: 'succeeded',
        scheme: msg.scheme,
        bundleId: msg.bundleId,
        durationMs: msg.durationMs,
      });
      break;
    case 'failed':
      if (msg.diagnostics) {
        proxy.pushBuildDiagnostics(msg.sessionId, msg.diagnostics, true);
      }
      proxy.pushBuildStatus(msg.sessionId, {
        state: 'failed',
        exitCode: msg.exitCode,
        durationMs: msg.durationMs,
        message: msg.message,
      });
      break;
  }
}

function handleSessionEvent(
  orch: Orchestrator,
  proxy: SessionProxy,
  msg: Extract<ReturnType<typeof HostToController.parse>, { type: 'session_event' }>,
): void {
  switch (msg.event) {
    case 'starting':
      orch.markStarting(msg.sessionId);
      proxy.updateState(msg.sessionId, 'starting');
      break;
    case 'ready': {
      const wi = msg.payload?.windowInfo;
      const sr = msg.payload?.screenRect;
      const dl = msg.payload?.deviceLogical;
      if (wi && sr && dl) proxy.updateCalibration(msg.sessionId, wi, sr, dl);
      orch.markStreaming(msg.sessionId);
      proxy.updateState(msg.sessionId, 'streaming');
      break;
    }
    case 'ended':
      // Host has fully released its side. Either it's confirming our earlier
      // stop_session, or self-terminating (after error). Either way, we can
      // now safely release the slot.
      orch.endSession(msg.sessionId, 'host reported ended');
      orch.confirmEndSession(msg.sessionId);
      proxy.updateState(msg.sessionId, 'ended');
      proxy.closeSession(msg.sessionId);
      break;
    case 'error':
      proxy.pushError(msg.sessionId, msg.payload?.message ?? 'unknown host error');
      orch.endSession(msg.sessionId, msg.payload?.message);
      // Host self-cleans after error (it calls stopSession internally) and
      // will follow up with session_event:ended which confirms slot release.
      proxy.updateState(msg.sessionId, 'error');
      proxy.closeSession(msg.sessionId);
      break;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Browser connection (one per session)
// ──────────────────────────────────────────────────────────────────────────────
function handleSessionConnection(
  ws: WebSocket,
  sessionId: string,
  orch: Orchestrator,
  proxy: SessionProxy,
): void {
  const session = orch.getSession(sessionId);
  if (!session) {
    try {
      ws.send(JSON.stringify({ type: 'error', message: 'session not found' }));
    } catch {
      /* ignore */
    }
    ws.close(4404, 'session not found');
    return;
  }

  proxy.attachBrowser(sessionId, ws);

  // Push the latest known queue position immediately.
  if (session.state === 'queued') {
    try {
      ws.send(
        JSON.stringify({
          type: 'state',
          state: 'queued',
          queuePosition: session.queuePosition ?? undefined,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  // Subscribe to orchestrator events for queue position updates & terminal state.
  const unsub = orch.onSessionEvent(sessionId, (rec) => {
    proxy.updateState(
      rec.sessionId,
      rec.state,
      rec.queuePosition ?? undefined,
      rec.lastReason ?? undefined,
    );
  });

  ws.on('message', (raw) => {
    const data = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    const msg = safeParse(BrowserToServer, data);
    if (!msg) return;
    switch (msg.type) {
      case 'input':
        orch.recordActivity(sessionId);
        orch.sendToHost(sessionId, { type: 'input', sessionId, input: msg.input });
        break;
      case 'set_calibration':
        orch.recordActivity(sessionId);
        orch.sendToHost(sessionId, {
          type: 'set_calibration',
          sessionId,
          screenRect: msg.screenRect,
        });
        break;
      case 'reset_calibration':
        orch.recordActivity(sessionId);
        orch.sendToHost(sessionId, { type: 'reset_calibration', sessionId });
        break;
      case 'ping':
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
          /* ignore */
        }
        break;
    }
  });

  ws.on('close', () => {
    unsub();
    proxy.detachBrowser(sessionId, ws);
  });
}
