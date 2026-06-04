// Minimal stand-in for the host agent's camera-server: accepts the shim's
// WebSocket connection (no token check) and pushes JPEG frames at ~15fps.
// Run from the host-agent package dir so `ws` resolves: node camera-shim/test/frame-server.mjs <framesDir> <port>
import { WebSocketServer } from 'ws';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'frames';
const port = parseInt(process.argv[3] || '8099', 10);
const files = readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
const frames = files.map((f) => readFileSync(path.join(dir, f)));
if (frames.length === 0) {
  console.error(`No .jpg frames in ${dir} — run gen-frames.swift first.`);
  process.exit(1);
}

const wss = new WebSocketServer({ host: '127.0.0.1', port, path: '/camera' });
console.log(`frame-server listening on ws://127.0.0.1:${port}/camera (${frames.length} frames)`);

wss.on('connection', (ws, req) => {
  console.log(`shim connected: ${req.url}`);
  let i = 0;
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(timer);
      return;
    }
    ws.send(frames[i % frames.length], { binary: true });
    i++;
  }, 66);
  ws.on('close', () => {
    clearInterval(timer);
    console.log(`shim disconnected after ${i} frames`);
  });
  ws.on('error', () => clearInterval(timer));
});
