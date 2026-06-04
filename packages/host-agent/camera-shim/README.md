# BotflowCameraShim

A DYLD-injected dylib that gives the iOS **Simulator** a working camera by
streaming the user's browser webcam into the app's `AVCaptureSession`.

## Why this exists

The iOS Simulator has no camera. `AVCaptureDevice.default(for: .video)` returns
`nil` and the real capture graph produces no frames. Apps that use the camera
therefore can't be exercised in the Simulator.

This shim swizzles `AVFoundation` so a **parallel fake capture graph** runs in
place of the (nonexistent) real one, fed by JPEG frames pulled over a WebSocket
from the host agent — which relays the browser's webcam:

```
browser getUserMedia → controller → host agent (camera-server.ts)
  → ws://127.0.0.1:<port>/camera (this shim)
  → swizzled AVCaptureSession / AVCaptureVideoDataOutput / preview layer
```

## How it's injected

The host agent launches the built app with:

```
SIMCTL_CHILD_DYLD_INSERT_LIBRARIES=<abs path>/BotflowCameraShim.dylib
SIMCTL_CHILD_BOTFLOW_CAMERA_URL=ws://127.0.0.1:<port>/camera?session=…&token=…
```

`simctl launch` forwards `SIMCTL_CHILD_*` env vars into the app process, so the
shim loads (via its `__attribute__((constructor))`) and reads
`BOTFLOW_CAMERA_URL` from the environment. **No change to the user's Xcode
project is required.**

## Build

```
./build.sh                # arm64 simulator dylib → ../assets/BotflowCameraShim.dylib
SHIM_INTEL=1 ./build.sh   # also include x86_64
```

This runs automatically via `pnpm --filter @sim/host-agent build`. The dylib MUST
target the iOS Simulator platform (`-sdk iphonesimulator`); `build.sh` prints the
`vtool` platform line to confirm `IOSSIMULATOR`.

## What's covered (v1)

- Device discovery (`AVCaptureDevice.default(for:)`, `devices(for:)`,
  `DiscoverySession.devices`, authorization) → synthetic "Botflow Webcam".
- `AVCaptureDeviceInput` creation for the synthetic device.
- `AVCaptureSession.addInput/addOutput/start/stopRunning` → drives the fake graph.
- `AVCaptureVideoDataOutput` sample-buffer delegate delivery.
- `AVCaptureVideoPreviewLayer` rendering.
- `AVCapturePhotoOutput.capturePhoto` → returns the current frame.

## Known limitations / follow-ups

- The sample-buffer `connection` argument is `nil` (the fake graph has no real
  ports). Apps that read the connection are unsupported in v1.
- `UIImagePickerController(sourceType: .camera)` is not intercepted.
- No microphone/audio.
- Photo delivery uses the deprecated sample-buffer delegate path; the modern
  `AVCapturePhoto` object can't be synthesized via public API.
- Swizzling `AVFoundation` is best-effort and may need additional hooks for
  exotic capture setups; iterate against real apps in the Simulator.
