# expo-simulator-stream

Stream an iOS Simulator to your browser with interactive touch, swipe, and scroll — no cables, no ADB, no screen mirroring app.

## How it works

- **Capture** — A Swift companion process uses [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit) to capture the Simulator window by window ID (works even when the window is behind other windows). Frames are JPEG-encoded and piped to Node.js via a length-prefixed binary protocol.
- **Stream** — An Express + WebSocket server pushes frames to the browser as base64 JPEGs.
- **Touch** — Clicks and swipes in the browser are forwarded to [idb](https://github.com/facebook/idb) (`idb ui tap / swipe`), which injects touches at device logical coordinates without moving your cursor.

## Requirements

- macOS 13+ (ScreenCaptureKit)
- Xcode + iOS Simulator
- Node.js 18+
- [idb](https://github.com/facebook/idb) — Facebook's iOS Development Bridge

### Install idb

```bash
# Tap the Facebook Homebrew formula
brew tap facebook/fb

# If brew install fails due to Xcode version, install the pre-built binary:
curl -L https://github.com/facebook/idb/releases/download/v1.1.8/idb-companion.universal.tar.gz | tar xz
cp bin/idb_companion /opt/homebrew/bin/
cp -r Frameworks/* /opt/homebrew/Frameworks/

# Install the Python CLI
pip3 install fb-idb
```

### macOS permissions

Grant **Screen Recording** permission to Terminal (or whichever app launches the server) in:
> System Settings → Privacy & Security → Screen Recording

## Setup

```bash
npm install
npm start
```

The Swift capturer compiles automatically on first run (~5s).

Open [http://localhost:3000](http://localhost:3000).

## Usage

1. Enter an Expo URL (e.g. `exp://192.168.x.x:8081` or `http://...`)
2. Click **Launch** — the server will boot iPhone 16 Pro, open Expo Go, load the URL, and start streaming
3. Click or drag on the device to interact
4. Scroll with the trackpad/mouse wheel

### Calibration

If taps land in the wrong place, click **Calibrate Screen Area** and drag the corner handles to match the device screen edges inside the simulator bezel.

## Architecture

```
Browser  ──WS frames──▶  server.js  ──spawn──▶  capturer (Swift/SCK)
         ◀─WS tap/swipe─             ──exec───▶  idb ui tap/swipe
```

| File | Role |
|------|------|
| `server.js` | Express + WebSocket server, simulator lifecycle, coordinate mapping |
| `capturer.swift` | ScreenCaptureKit companion — finds window, streams JPEG frames to stdout |
| `public/index.html` | Browser UI — canvas rendering, touch events, calibration overlay |
