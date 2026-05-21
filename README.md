# sim.stream — iOS Simulator Streaming Platform

Stream iOS simulators to a browser with full touch / swipe / scroll
interactivity. Architected as a Controller + Host Agent + Web frontend
monorepo so the same code scales from one MacBook to a Mac fleet without
rewriting.

```
Browser ──HTTPS+WSS──▶ Controller ──WS──▶ Host Agent ──▶ iOS Simulator
                          │                              capturer.swift (SCK)
                          │                              idb (touch input)
                          └─ session registry, queue, placement
```

## Quick start (one Mac, local-only)

```bash
pnpm install
pnpm dev          # runs controller, host-agent, and web in parallel
```

Then open <http://localhost:3000> and click **Launch**.

Or run each service separately in its own terminal:

```bash
pnpm dev:controller   # :8080 — orchestrator, REST, WS
pnpm dev:host         # connects out to :8080
pnpm dev:web          # :3000 — Next.js
```

## Requirements

- macOS 13+ (ScreenCaptureKit)
- Xcode + at least one iOS Simulator runtime installed
- Node.js 20+
- `pnpm` (`npm install -g pnpm`)
- [idb](https://github.com/facebook/idb) — Facebook's iOS Development Bridge

### Install idb

```bash
brew tap facebook/fb
brew install idb-companion
pip3 install fb-idb
```

If `brew install idb-companion` fails due to Xcode versioning, see the legacy
README in git history for the manual install path.

Grant **Screen Recording** permission to your terminal:
`System Settings → Privacy & Security → Screen Recording`.

## Packages

| Package | Purpose |
|---------|---------|
| `packages/shared` | Wire protocol — Zod schemas + TS types shared by all three services. |
| `packages/host-agent` | Runs on each Mac. Manages local simulators via `simctl`, captures their windows via ScreenCaptureKit, injects input via `idb`. Connects outbound to the Controller (no inbound port required). |
| `packages/controller` | Orchestrator: REST API, WebSocket endpoints, session registry, FIFO queue, host registry, frame/input proxy. In-memory state (single instance). |
| `packages/web` | Next.js (App Router) frontend with the launch + streaming UI. |
| `infra/` | Cloudflare Tunnel config + setup walkthrough. |

## Configuration

Each service reads its config from env vars. Defaults work for local dev.

### Controller

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `8080` | HTTP + WS listen port |
| `HOST_TOKEN` | `dev-token` | Shared secret with host agents |
| `SIM_PLATFORM_TOKEN` | *(unset)* | Required on `POST /api/sessions/:id/build`. When unset, the build endpoint is open. |
| `ALLOWED_ORIGINS` | `*` | CORS origins for the REST API |
| `MAX_BUILD_BODY_MB` | `50` | Tarball upload cap |

### Host Agent

| Var | Default | Notes |
|-----|---------|-------|
| `CONTROLLER_URL` | `ws://127.0.0.1:8080/ws/host` | Where to dial |
| `HOST_TOKEN` | `dev-token` | Shared with controller |
| `HOST_ID` | `<hostname>-<pid>` | Identifier in the fleet |
| `HOST_SLOTS` | `2` | Concurrent simulators on this Mac |
| `SIM_CAPTURE_MODE` | `sck` | `framebuffer` for native H.264 framebuffer streaming, `simctl` for JPEG screenshot fallback, `sck` for legacy window capture |
| `SIM_FRAMEBUFFER_FPS` | `60` | Target H.264 frame rate in `framebuffer` mode |
| `SIM_FRAMEBUFFER_BITRATE` | `6000000` | H.264 bitrate in bits/sec |
| `SIM_FRAMEBUFFER_KEYFRAME_INTERVAL` | `SIM_FRAMEBUFFER_FPS` | H.264 keyframe interval in frames |

### Web

| Var | Default | Notes |
|-----|---------|-------|
| `NEXT_PUBLIC_CONTROLLER_URL` | `http://127.0.0.1:8080` | REST rewrites target |
| `NEXT_PUBLIC_WS_BASE` | derived | `ws://...` base for stream WS |

## Known limitations (PoC)

- **Framebuffer H.264 uses private CoreSimulator APIs.** `SIM_CAPTURE_MODE=framebuffer`
  captures the simulator framebuffer directly and avoids Screen Recording/TCC,
  macOS window chrome, and Mission Control artifacts. It is the preferred
  high-performance path, but Xcode updates can move private selectors, so keep
  `SIM_CAPTURE_MODE=simctl` as the operational fallback.

- **Multi-session SCK interruption.** Booting a 2nd iOS Simulator while another
  one is being captured currently interrupts the first capturer's
  `SCStream` (`STREAM_ERROR: Failed during stream due to application connection
  being interrupted`). The plumbing — orchestration, queueing, frame proxy — works
  end-to-end with two concurrent slots; the SCK side just doesn't survive the
  Simulator.app rearranging windows. Two ways to fix later:
  1. **Capturer auto-restart.** Detect `STREAM_ERROR` in `host-agent/src/session.ts`
     and respawn the capturer (the window-ID is still valid) — cheap fix.
  2. **Display-based SCK filter.** Capture the whole display and crop to the
     window's frame on the Node side — bypasses the per-window stream lifetime.

- **In-memory state.** Restarting the Controller drops the session registry and
  queue. Add SQLite / Postgres when the PoC graduates.

## Exposing to the internet

The Controller and Web app run on localhost only.

- **Quick path (Tailscale Funnel)** — no custom domain, public `*.ts.net` URL.
  See [infra/tailscale-funnel.md](./infra/tailscale-funnel.md).
- **Custom domain (Cloudflare Tunnel)** — see [infra/README.md](./infra/README.md).

## Build & Run for Swift projects

The Controller exposes `POST /api/sessions/:id/build` so an external platform
(e.g. webcontainer-ide) can ship a tarball, run xcodebuild, and install/launch
the resulting `.app` on a streaming simulator session.

Request:

```http
POST /api/sessions/<sessionId>/build
X-Platform-Token: <SIM_PLATFORM_TOKEN>
X-Build-Scheme: <optional scheme override>
X-Build-Bundle-Id: <optional bundle id override>
Content-Type: application/octet-stream

<tarball bytes, gzipped tar>
```

If `SIM_PLATFORM_TOKEN` is set, requests without a matching `X-Platform-Token`
header are rejected with 401.

On first upload for a session, the host runs the full pipeline
(boot → build → install → launch → capture). On subsequent uploads against a
streaming session, only the build → install → launch is re-run; the simulator
and stream stay live.
