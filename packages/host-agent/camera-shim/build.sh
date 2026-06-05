#!/usr/bin/env bash
# Build BotflowCameraShim.dylib for the iOS Simulator and drop it into the
# host-agent's assets/ dir, where camera-server.ts resolves it at runtime.
#
# The dylib is injected into the user's app at launch via
# SIMCTL_CHILD_DYLD_INSERT_LIBRARIES, so it MUST be built for the simulator
# platform (LC_BUILD_VERSION platform = iOS Simulator) — that's what
# `-sdk iphonesimulator` + `-mios-simulator-version-min` produce.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$HERE/../assets"
OUT="$OUT_DIR/BotflowCameraShim.dylib"
mkdir -p "$OUT_DIR"

# Build a fat arm64+x86_64 simulator dylib so it works on Apple Silicon and
# Intel hosts alike. (Most CI/dev Macs are arm64; x86_64 kept for safety.)
ARCHS=(-arch arm64)
if [[ "${SHIM_INTEL:-0}" == "1" ]]; then
  ARCHS+=(-arch x86_64)
fi

xcrun -sdk iphonesimulator clang -dynamiclib \
  "${ARCHS[@]}" \
  -mios-simulator-version-min=15.0 \
  -fobjc-arc \
  -fmodules \
  -framework Foundation \
  -framework AVFoundation \
  -framework CoreMedia \
  -framework CoreVideo \
  -framework CoreGraphics \
  -framework ImageIO \
  -framework QuartzCore \
  -install_name "@rpath/BotflowCameraShim.dylib" \
  -o "$OUT" \
  "$HERE/BotflowCameraShim.m"

echo "Built $OUT"
xcrun vtool -show "$OUT" 2>/dev/null | grep -i platform || true
