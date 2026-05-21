import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Orchestrator } from './orchestrator.js';
import { SessionProxy } from './proxy.js';
import { sessionRouter } from './routes/sessions.js';
import { attachWS } from './routes/ws.js';
import { log } from './log.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const HOST_TOKEN = process.env.HOST_TOKEN ?? 'dev-token';
const PLATFORM_TOKEN = process.env.SIM_PLATFORM_TOKEN ?? null;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim());
const MAX_BUILD_BODY_BYTES = parseInt(process.env.MAX_BUILD_BODY_MB ?? '50', 10) * 1024 * 1024;

const orch = new Orchestrator();
const proxy = new SessionProxy();
// Auto-end a session whose browser has been gone for the configured grace
// window. This prevents a refresh-killed tab from holding a slot forever.
proxy.onSessionAbandoned = (sessionId) => {
  log(`Session ${sessionId.slice(0, 8)} abandoned by browser; auto-ending.`);
  orch.endSession(sessionId, 'browser disconnected');
  proxy.closeSession(sessionId);
};

const app = express();
app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
    credentials: false,
    exposedHeaders: ['x-platform-token'],
  }),
);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    hosts: orch.listHosts().map((h) => ({
      id: h.hostId,
      slots: h.slots,
      active: h.activeSessionIds.size,
      lastHeartbeat: h.lastHeartbeat,
    })),
  });
});

app.use(
  '/api/sessions',
  sessionRouter(orch, {
    platformToken: PLATFORM_TOKEN,
    maxBuildBodyBytes: MAX_BUILD_BODY_BYTES,
  }),
);

const server = http.createServer(app);
attachWS(server, orch, proxy, { hostToken: HOST_TOKEN });

server.listen(PORT, () => {
  log(`Controller listening on http://0.0.0.0:${PORT}`);
  log(`  /api/sessions          — REST`);
  log(`  /api/sessions/:id/build — Build upload (token: ${PLATFORM_TOKEN ? 'required' : 'OPEN'})`);
  log(`  /ws/host               — Host Agent connection (token: ${HOST_TOKEN === 'dev-token' ? 'DEV' : 'configured'})`);
  log(`  /ws/session/:id        — Browser stream`);
});

const shutdown = (signal: NodeJS.Signals): void => {
  log(`Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
