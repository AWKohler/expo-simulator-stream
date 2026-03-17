const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ────────────────────────────────────────────
// Paths
// ────────────────────────────────────────────
const CAPTURER_SWIFT = path.join(__dirname, 'capturer.swift');
const CAPTURER_BIN   = path.join(os.tmpdir(), 'expo_stream_capturer');

// ────────────────────────────────────────────
// State
// ────────────────────────────────────────────
let state = {
  udid: null,
  deviceName: null,

  // ScreenCaptureKit companion process
  capturerProc: null,
  capturerReady: false,

  // Window geometry (logical macOS points, from capturer stderr)
  windowInfo: null, // { id, x, y, w, h, scale }

  // Coordinate mapping: where the device screen lives inside the window image
  // Stored in logical window-relative coordinates (0–1 normalized to window w/h)
  screenRect: null, // { left, top, right, bottom } — normalized 0–1 of window

  // Device logical screen size (from simctl screenshot)
  deviceLogical: { w: 393, h: 852 }, // default iPhone 16 Pro

  // Binary readiness
  capturerBinReady: false,

  // idb
  hasIDB: false,
};

const clients = new Set();

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function broadcast(msg) {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(data);
  }
}

function broadcastStatus(message, type = 'status') {
  broadcast({ type, message });
}

function log(msg) {
  process.stdout.write(`[expo-stream] ${msg}\n`);
}

// ────────────────────────────────────────────
// Capability detection
// ────────────────────────────────────────────
// Candidate locations for the idb binary.
// pip3/conda can install it into various prefixes depending on the environment.
const IDB_CANDIDATES = [
  'idb',                                        // already on PATH
  '/opt/anaconda3/bin/idb',                     // conda base
  '/opt/homebrew/bin/idb',                      // homebrew (Apple Silicon)
  '/usr/local/bin/idb',                         // homebrew (Intel)
  `${os.homedir()}/anaconda3/bin/idb`,          // user-local conda
  `${os.homedir()}/.local/bin/idb`,             // pip --user installs
  '/opt/miniconda3/bin/idb',
  `${os.homedir()}/miniconda3/bin/idb`,
];

function findIDB() {
  // Also try asking the shell — picks up PATH expansions, pyenv, etc.
  try {
    const found = execSync('bash -lc "which idb"', { stdio: 'pipe' }).toString().trim();
    if (found) return found;
  } catch (_) {}

  for (const candidate of IDB_CANDIDATES) {
    try {
      execSync(`"${candidate}" --version`, { stdio: 'pipe' });
      return candidate;
    } catch (_) {}
  }
  return null;
}

let IDB_BIN = 'idb';           // overwritten on detection
let IDB_COMPANION_BIN = null;  // path to idb_companion binary

function detectCapabilities() {
  const found = findIDB();
  if (found) {
    IDB_BIN = found;
    state.hasIDB = true;
    log(`idb found at: ${IDB_BIN}`);
  } else {
    log('idb not found. Install with:');
    log('  brew tap facebook/fb && brew install idb-companion');
    log('  pip3 install fb-idb');
  }

  // Locate idb_companion for pre-warming
  const companionCandidates = [
    '/opt/homebrew/bin/idb_companion',
    '/usr/local/bin/idb_companion',
  ];
  for (const c of companionCandidates) {
    if (fs.existsSync(c)) { IDB_COMPANION_BIN = c; break; }
  }
  if (!IDB_COMPANION_BIN) {
    try {
      IDB_COMPANION_BIN = execSync('which idb_companion', { stdio: 'pipe' }).toString().trim() || null;
    } catch (_) {}
  }
  if (IDB_COMPANION_BIN) log(`idb_companion found at: ${IDB_COMPANION_BIN}`);
}

// Pre-warm idb_companion for a UDID so the first tap is instant.
// idb_companion starts a gRPC server; the idb Python client connects to it.
// Without pre-warming, the first idb command cold-starts the companion (~3-5s)
// and the tap command itself times out.
let companionProc = null;
function startCompanion(udid) {
  if (!IDB_COMPANION_BIN) return;
  if (companionProc) { companionProc.kill(); companionProc = null; }

  log(`Starting idb_companion for ${udid}...`);
  companionProc = spawn(IDB_COMPANION_BIN, ['--udid', udid], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  companionProc.stdout.on('data', (d) => log('companion: ' + d.toString().trim()));
  companionProc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) log('companion: ' + msg);
  });
  companionProc.on('exit', (code) => {
    log(`idb_companion exited: ${code}`);
    companionProc = null;
  });
}

// ────────────────────────────────────────────
// Binary compilation
// ────────────────────────────────────────────
async function compileCapturerBinary() {
  return new Promise((resolve) => {
    // Check if binary is newer than source; skip recompile if so.
    try {
      const binStat = fs.statSync(CAPTURER_BIN);
      const srcStat = fs.statSync(CAPTURER_SWIFT);
      if (binStat.mtimeMs > srcStat.mtimeMs) {
        log('Capturer binary up-to-date, skipping compile.');
        return resolve(true);
      }
    } catch (_) {}

    log('Compiling ScreenCaptureKit capturer (~5s)...');
    exec(`swiftc "${CAPTURER_SWIFT}" -o "${CAPTURER_BIN}"`, (err, _stdout, stderr) => {
      if (err) {
        log('Capturer compile failed:\n' + (stderr || err.message));
        resolve(false);
      } else {
        log('Capturer binary ready.');
        resolve(true);
      }
    });
  });
}

// ────────────────────────────────────────────
// Simulator management
// ────────────────────────────────────────────
function findSimulator() {
  const json = JSON.parse(execSync('xcrun simctl list devices --json').toString());
  for (const devices of Object.values(json.devices)) {
    for (const d of devices) {
      if (d.name === 'iPhone 16 Pro' && d.isAvailable) return { udid: d.udid, name: d.name, state: d.state };
    }
  }
  return null;
}

function getSimulatorState(udid) {
  try {
    const json = JSON.parse(execSync('xcrun simctl list devices --json').toString());
    for (const devices of Object.values(json.devices)) {
      for (const d of devices) { if (d.udid === udid) return d.state; }
    }
  } catch (_) {}
  return 'Unknown';
}

async function waitForBoot(udid, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (getSimulatorState(udid) === 'Booted') return true;
    await sleep(2000);
  }
  return false;
}

// ────────────────────────────────────────────
// Device screen dimensions from simctl
// ────────────────────────────────────────────
async function probeDeviceScreenSize(udid) {
  const tmp = path.join(os.tmpdir(), 'expo_probe_frame.jpg');
  return new Promise((resolve) => {
    exec(`xcrun simctl io ${udid} screenshot --type=jpeg "${tmp}"`, (err) => {
      if (err) { resolve(null); return; }
      try {
        // Use sips to get dimensions without reading the whole file
        const out = execSync(`sips -g pixelWidth -g pixelHeight "${tmp}"`).toString();
        const w = parseInt(out.match(/pixelWidth: (\d+)/)?.[1] ?? '0');
        const h = parseInt(out.match(/pixelHeight: (\d+)/)?.[1] ?? '0');
        if (w && h) resolve({ w, h });
        else resolve(null);
      } catch (_) { resolve(null); }
    });
  });
}

// ────────────────────────────────────────────
// Coordinate mapping
// ────────────────────────────────────────────
// iPhone 16 Pro device model (with bezel) is ~0.914× the window content area.
// The thin metal frame accounts for the remaining ~8.6%, evenly split on all sides.
// These fractions are scale-invariant (hold at any simulator zoom level).
const BEZEL_FRAC = 0.043; // ~4.3% of device model on each side
const TITLE_BAR_H = 28;   // macOS window title bar, logical points

function computeScreenRect(windowInfo) {
  const { w: ww, h: wh } = windowInfo;
  const contentH = wh - TITLE_BAR_H;
  return {
    // left/right: symmetric horizontal bezel
    left:   ww * BEZEL_FRAC,
    right:  ww * (1 - BEZEL_FRAC),
    // top: title bar + top bezel; bottom: symmetric to top within content area
    top:    TITLE_BAR_H + contentH * BEZEL_FRAC,
    bottom: TITLE_BAR_H + contentH * (1 - BEZEL_FRAC),
  };
}

// normX/normY: 0–1 relative to the full SCK-captured window image (physical pixels)
// Returns device logical coordinates for idb (e.g., 0–393, 0–852 for iPhone 16 Pro)
function windowNormToDeviceLogical(normX, normY) {
  const { screenRect, windowInfo, deviceLogical } = state;
  if (!screenRect || !windowInfo) return null;

  const { w: ww, h: wh } = windowInfo;
  const { left, top, right, bottom } = screenRect;

  // Map from window logical to screen-relative
  const absX = normX * ww;
  const absY = normY * wh;

  const sx = (absX - left) / (right - left);
  const sy = (absY - top)  / (bottom - top);

  if (sx < 0 || sx > 1 || sy < 0 || sy > 1) return null; // clicked in bezel

  return {
    x: Math.round(sx * deviceLogical.w),
    y: Math.round(sy * deviceLogical.h),
  };
}

// ────────────────────────────────────────────
// ScreenCaptureKit capturer process
// ────────────────────────────────────────────
let frameBuffer = Buffer.alloc(0);

function stopCapturer() {
  if (state.capturerProc) {
    state.capturerProc.kill();
    state.capturerProc = null;
    state.capturerReady = false;
    state.windowInfo = null;
    state.screenRect = null;
  }
  frameBuffer = Buffer.alloc(0);
}

function startCapturer(deviceName) {
  stopCapturer();

  if (!state.capturerBinReady) {
    broadcastStatus('SCK capture binary not available — falling back to screencapture.', 'warn');
    startScreencaptureLoop();
    return;
  }

  log(`Starting SCK capturer for "${deviceName}"...`);
  const proc = spawn(CAPTURER_BIN, [deviceName, '--fps=30', '--quality=0.75']);
  state.capturerProc = proc;

  // ── Parse WINDOW_INFO from stderr ──
  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop(); // keep incomplete line

    for (const line of lines) {
      log('capturer: ' + line);

      if (line.startsWith('WINDOW_INFO:')) {
        // WINDOW_INFO: id=X x=Y w=W h=H scale=S title=T
        const nums = {};
        for (const kv of line.replace('WINDOW_INFO:', '').trim().split(' ')) {
          const [k, v] = kv.split('=');
          if (k && v) nums[k] = isNaN(v) ? v : parseFloat(v);
        }
        state.windowInfo = { id: nums.id, x: nums.x, y: nums.y, w: nums.w, h: nums.h, scale: nums.scale };
        state.screenRect = computeScreenRect(state.windowInfo);
        log(`Window: ${JSON.stringify(state.windowInfo)}`);
        log(`Screen rect: ${JSON.stringify(state.screenRect)}`);
        broadcast({ type: 'calibration', screenRect: state.screenRect, windowInfo: state.windowInfo });
      }

      if (line.startsWith('STREAM_STARTED')) {
        state.capturerReady = true;
        broadcast({ type: 'ready', message: 'Live! Click or drag on the screen.' });
      }

      if (line.startsWith('ERROR:')) {
        broadcastStatus(line, 'error');
      }
    }
  });

  // ── Parse length-prefixed JPEG frames from stdout ──
  let framesParsed = 0;
  proc.stdout.on('data', (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);

    while (frameBuffer.length >= 4) {
      const frameLen = frameBuffer.readUInt32BE(0);
      if (frameLen > 10_000_000) { // >10MB is definitely corrupt, reset
        log('Frame buffer corruption, resetting.');
        frameBuffer = Buffer.alloc(0);
        break;
      }
      if (frameBuffer.length < 4 + frameLen) break; // wait for rest of frame

      const frame = frameBuffer.subarray(4, 4 + frameLen);
      frameBuffer = frameBuffer.subarray(4 + frameLen);
      framesParsed++;
      if (framesParsed === 1) log(`First frame parsed: ${frame.length} bytes — stream is flowing`);

      if (clients.size > 0) {
        broadcast({ type: 'frame', data: frame.toString('base64'), format: 'jpeg' });
      }
    }
  });

  proc.on('exit', (code, signal) => {
    log(`Capturer exited: code=${code} signal=${signal}`);
    if (state.capturerProc === proc) {
      state.capturerProc = null;
      state.capturerReady = false;
      if (code !== 0 && code !== null) {
        broadcastStatus('Capturer process exited unexpectedly. Check Screen Recording permission.', 'error');
      }
    }
  });
}

// ────────────────────────────────────────────
// Fallback: screencapture loop (if SCK not available)
// ────────────────────────────────────────────
const FALLBACK_FRAME_PATH = path.join(os.tmpdir(), 'expo_stream_fallback.jpg');
let fallbackCapturing = false;
let fallbackTimer = null;

function stopScreencaptureLoop() {
  fallbackCapturing = false;
  if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
}

function startScreencaptureLoop() {
  stopScreencaptureLoop();
  if (!state.windowInfo) {
    broadcastStatus('Cannot start fallback capture: no window bounds.', 'error');
    return;
  }
  fallbackCapturing = true;

  const capture = () => {
    if (!fallbackCapturing || clients.size === 0) { fallbackTimer = setTimeout(capture, 150); return; }
    const { x, y, w, h } = state.windowInfo;
    exec(`screencapture -x -R ${x},${y},${w},${h} -t jpg "${FALLBACK_FRAME_PATH}"`, (err) => {
      if (!err) {
        try {
          const data = fs.readFileSync(FALLBACK_FRAME_PATH);
          broadcast({ type: 'frame', data: data.toString('base64'), format: 'jpeg' });
        } catch (_) {}
      }
      if (fallbackCapturing) fallbackTimer = setTimeout(capture, 100);
    });
  };
  capture();
}

// ────────────────────────────────────────────
// Touch injection
// ────────────────────────────────────────────
function idbCommand(args, label) {
  if (!state.hasIDB || !state.udid) return;
  const cmd = `"${IDB_BIN}" ${args} --udid ${state.udid}`;
  log(`idb cmd: ${cmd}`);
  exec(cmd, (err, stdout, stderr) => {
    if (stdout) log(`idb ${label} stdout: ${stdout.trim()}`);
    if (stderr) log(`idb ${label} stderr: ${stderr.trim().split('\n')[0]}`);
    if (err)    log(`idb ${label} error: ${err.message.split('\n')[0]}`);
  });
}

function clampPt(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }

function injectTap(normX, normY) {
  log(`Tap received: normX=${normX.toFixed(3)} normY=${normY.toFixed(3)} windowInfo=${!!state.windowInfo} screenRect=${!!state.screenRect}`);
  const logical = windowNormToDeviceLogical(normX, normY);
  if (!logical) {
    log(`Tap in bezel/null (normX=${normX.toFixed(2)} normY=${normY.toFixed(2)})`);
    return;
  }
  log(`Tap → idb (${logical.x}, ${logical.y})`);
  idbCommand(`ui tap ${logical.x} ${logical.y}`, 'tap');
}

function injectSwipe(startNormX, startNormY, endNormX, endNormY) {
  const { w: dw, h: dh } = state.deviceLogical;
  const toLogical = (nx, ny) => {
    const l = windowNormToDeviceLogical(nx, ny);
    // If in bezel, clamp to nearest screen edge
    if (!l) return {
      x: clampPt(nx * dw, 0, dw),
      y: clampPt(ny * dh, 0, dh),
    };
    return l;
  };
  const s = toLogical(startNormX, startNormY);
  const e = toLogical(endNormX,   endNormY);
  log(`Swipe → idb (${s.x},${s.y}) → (${e.x},${e.y})`);
  idbCommand(`ui swipe ${s.x} ${s.y} ${e.x} ${e.y}`, 'swipe');
}

// Scroll: convert wheel delta → swipe gesture.
// Debounced: accumulate deltas for 80ms then fire one swipe.
let scrollAcc = { dx: 0, dy: 0, normX: 0.5, normY: 0.5 };
let scrollTimer = null;

function injectScroll(normX, normY, deltaX, deltaY) {
  scrollAcc.dx   += deltaX;
  scrollAcc.dy   += deltaY;
  scrollAcc.normX = normX;
  scrollAcc.normY = normY;

  if (scrollTimer) return; // already pending
  scrollTimer = setTimeout(() => {
    scrollTimer = null;
    const { dx, dy, normX: nx, normY: ny } = scrollAcc;
    scrollAcc = { dx: 0, dy: 0, normX: 0.5, normY: 0.5 };

    const anchor = windowNormToDeviceLogical(nx, ny) ?? {
      x: Math.round(nx * state.deviceLogical.w),
      y: Math.round(ny * state.deviceLogical.h),
    };
    const { w: dw, h: dh } = state.deviceLogical;

    // Scroll speed: 3 device-logical-points per CSS pixel of wheel delta.
    // deltaY > 0 = content scroll down = finger swipes UP = Y decreases.
    const SPEED = 3;
    const swipeDist = Math.min(400, Math.abs(dy) * SPEED);
    const swipeDistX = Math.min(400, Math.abs(dx) * SPEED);

    if (swipeDist < 5 && swipeDistX < 5) return; // ignore sub-threshold twitches

    // Vertical scroll
    if (swipeDist >= swipeDistX) {
      const dir = dy > 0 ? -1 : 1;
      const startY = clampPt(anchor.y - dir * swipeDist / 2, 0, dh);
      const endY   = clampPt(anchor.y + dir * swipeDist / 2, 0, dh);
      log(`Scroll → idb swipe Y (${anchor.x},${startY}) → (${anchor.x},${endY})`);
      idbCommand(`ui swipe ${anchor.x} ${startY} ${anchor.x} ${endY}`, 'scroll-y');
    } else {
      // Horizontal scroll
      const dir = dx > 0 ? -1 : 1;
      const startX = clampPt(anchor.x - dir * swipeDistX / 2, 0, dw);
      const endX   = clampPt(anchor.x + dir * swipeDistX / 2, 0, dw);
      log(`Scroll → idb swipe X (${startX},${anchor.y}) → (${endX},${anchor.y})`);
      idbCommand(`ui swipe ${startX} ${anchor.y} ${endX} ${anchor.y}`, 'scroll-x');
    }
  }, 80);
}

// ────────────────────────────────────────────
// Launch sequence
// ────────────────────────────────────────────
async function launchExpo(url) {
  stopCapturer();
  stopScreencaptureLoop();

  broadcastStatus('Finding iPhone 16 Pro simulator...');
  const sim = findSimulator();
  if (!sim) {
    broadcastStatus('ERROR: iPhone 16 Pro not found. Create one in Xcode first.', 'error');
    return;
  }
  state.udid = sim.udid;
  state.deviceName = sim.name;
  log(`Found: ${sim.name} (${sim.udid}) [${sim.state}]`);

  broadcastStatus('Booting simulator...');
  exec(`xcrun simctl boot ${sim.udid}`, () => {});
  exec('open -a Simulator');

  const booted = await waitForBoot(sim.udid);
  if (!booted) {
    broadcastStatus('ERROR: Simulator timed out during boot.', 'error');
    return;
  }

  broadcastStatus('Launching Expo Go...');
  await new Promise((r) => exec(`xcrun simctl launch ${sim.udid} host.exp.Exponent`, r));
  await sleep(2500);

  // Convert http → exp:// to open directly in Expo Go, bypassing the system prompt
  let expoUrl = url;
  if (/^https?:\/\//i.test(url)) {
    expoUrl = url.replace(/^https?:\/\//i, 'exp://');
  }
  broadcastStatus(`Opening ${expoUrl} ...`);
  await new Promise((r) => exec(`xcrun simctl openurl ${sim.udid} "${expoUrl}"`, r));
  await sleep(3000);

  // Probe device screen size for accurate coordinate mapping
  broadcastStatus('Probing device screen dimensions...');
  const physSize = await probeDeviceScreenSize(sim.udid);
  if (physSize) {
    // iPhone 16 Pro: 1179×2556 physical → 393×852 logical (@3x)
    const scale = Math.round(physSize.w / 393); // detect scale factor (2 or 3)
    state.deviceLogical = {
      w: Math.round(physSize.w / scale),
      h: Math.round(physSize.h / scale),
    };
    log(`Device screen: ${physSize.w}×${physSize.h}px @${scale}x → logical ${state.deviceLogical.w}×${state.deviceLogical.h}pt`);
  }

  // Pre-warm idb_companion so the first tap is instant.
  // Without this, the first `idb ui tap` cold-starts the companion (~3-5s),
  // which causes the command to time out and the tap is lost.
  if (state.hasIDB) {
    broadcastStatus('Starting idb companion...');
    startCompanion(sim.udid);
    await sleep(2000); // give companion time to bind its gRPC port
  }

  broadcastStatus('Starting ScreenCaptureKit capture...');
  await sleep(500); // let Simulator window settle

  startCapturer(sim.name);

  broadcast({
    type: 'capabilities',
    hasIDB: state.hasIDB,
    captureMethod: state.capturerBinReady ? 'ScreenCaptureKit' : 'screencapture',
    deviceLogical: state.deviceLogical,
  });
}

// ────────────────────────────────────────────
// WebSocket
// ────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  log(`Client connected (${clients.size} total)`);

  // Send current capabilities immediately
  ws.send(JSON.stringify({
    type: 'capabilities',
    hasIDB: state.hasIDB,
    captureMethod: state.capturerBinReady ? 'ScreenCaptureKit' : 'screencapture',
  }));

  // If stream is already live, catch up the new client
  if (state.capturerReady) {
    ws.send(JSON.stringify({ type: 'ready', message: 'Live! Click or drag on the screen.' }));
    if (state.windowInfo) {
      ws.send(JSON.stringify({ type: 'calibration', screenRect: state.screenRect, windowInfo: state.windowInfo }));
    }
    ws.send(JSON.stringify({ type: 'capabilities', hasIDB: state.hasIDB,
      captureMethod: 'ScreenCaptureKit', deviceLogical: state.deviceLogical }));
  }

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {

        case 'launch':
          broadcast({ type: 'launching' });
          await launchExpo(msg.url);
          break;

        case 'tap':
          injectTap(msg.normX, msg.normY);
          break;

        case 'swipe':
          injectSwipe(msg.startX, msg.startY, msg.endX, msg.endY);
          break;

        case 'scroll':
          injectScroll(msg.normX, msg.normY, msg.deltaX ?? 0, msg.deltaY ?? 0);
          break;

        case 'stop':
          stopCapturer();
          stopScreencaptureLoop();
          broadcast({ type: 'stopped' });
          break;

        // Manual calibration override: user sends corrected screen rect
        case 'set_calibration': {
          // msg.screenRect = { left, top, right, bottom } in logical window points
          state.screenRect = msg.screenRect;
          broadcast({ type: 'calibration', screenRect: state.screenRect, windowInfo: state.windowInfo });
          log('Calibration updated: ' + JSON.stringify(state.screenRect));
          break;
        }

        // Reset calibration to auto-computed values
        case 'reset_calibration':
          if (state.windowInfo) {
            state.screenRect = computeScreenRect(state.windowInfo);
            broadcast({ type: 'calibration', screenRect: state.screenRect, windowInfo: state.windowInfo });
          }
          break;
      }
    } catch (e) {
      log('WS message error: ' + e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    log(`Client disconnected (${clients.size} remaining)`);
    if (clients.size === 0) {
      stopCapturer();
      stopScreencaptureLoop();
    }
  });
});

// ────────────────────────────────────────────
// Debug endpoint
// ────────────────────────────────────────────
app.get('/api/debug', (_req, res) => {
  res.json({
    idb: { bin: IDB_BIN, companionBin: IDB_COMPANION_BIN, hasIDB: state.hasIDB },
    capturer: {
      binReady: state.capturerBinReady,
      binPath: CAPTURER_BIN,
      running: !!state.capturerProc,
      ready: state.capturerReady,
    },
    windowInfo: state.windowInfo,
    screenRect: state.screenRect,
    deviceLogical: state.deviceLogical,
    udid: state.udid,
    clients: clients.size,
  });
});

// Test a tap directly (for debugging coordinate mapping)
app.post('/api/tap', (req, res) => {
  const { x, y } = req.body;
  if (!state.hasIDB || !state.udid) return res.json({ ok: false, reason: 'no idb or udid' });
  exec(`"${IDB_BIN}" ui tap ${x} ${y} --udid ${state.udid}`, (err, stdout, stderr) => {
    res.json({ ok: !err, err: err?.message, stdout, stderr });
  });
});

// ────────────────────────────────────────────
// Startup
// ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  log(`Expo Stream → http://localhost:${PORT}`);
  detectCapabilities();
  state.capturerBinReady = await compileCapturerBinary();
  broadcast({
    type: 'capabilities',
    hasIDB: state.hasIDB,
    captureMethod: state.capturerBinReady ? 'ScreenCaptureKit' : 'screencapture',
  });
  log('Ready.');
});
