#!/usr/bin/env bash
#
# Build whisper.cpp's `whisper-cli` and drop it in `bin/` so it ships inside the
# packaged app (see `build.*.extraResources` and `resolveWhisperCli()` in
# electron/main.ts). Without this the app can't transcribe unless the user
# installs whisper.cpp themselves.
#
# On Windows we build BOTH x64 and arm64 helpers (whisper-cli-x64.exe and
# whisper-cli-arm64.exe) so the single combined NSIS installer can bundle a
# native helper for each architecture. On macOS/Linux we build one
# host-architecture `whisper-cli`.
#
# Idempotent: skips an output that is already present. Runs from CI and can be
# run locally before `npm run dist`.
#
# Pin the source with WHISPER_CPP_REF; skip entirely with SKIP_WHISPER_CLI=1.
set -euo pipefail

WHISPER_CPP_REF="${WHISPER_CPP_REF:-v1.9.3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/bin"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) IS_WIN=1 ;;
  *) IS_WIN=0 ;;
esac
IS_MAC=0; [ "$(uname -s)" = "Darwin" ] && IS_MAC=1

if [ "${SKIP_WHISPER_CLI:-}" = "1" ]; then
  echo "[fetch-whisper-cli] SKIP_WHISPER_CLI=1 — skipping."
  exit 0
fi

mkdir -p "$BIN_DIR"

# whisper.cpp is cloned once and reused for every arch we build.
SRC=""
ensure_src() {
  [ -n "$SRC" ] && return 0
  SRC="$(mktemp -d)"
  echo "[fetch-whisper-cli] cloning whisper.cpp $WHISPER_CPP_REF"
  git clone --depth 1 --branch "$WHISPER_CPP_REF" \
    https://github.com/ggml-org/whisper.cpp "$SRC/src"
}
cleanup() { [ -n "$SRC" ] && rm -rf "$SRC"; }
trap cleanup EXIT

# build_one <out_file> [win_arch]
#   win_arch is "x64" or "arm64" on Windows; empty on macOS/Linux.
build_one() {
  local OUT="$1"; local WIN_ARCH="${2:-}"
  if [ -f "$OUT" ]; then
    echo "[fetch-whisper-cli] $OUT already present — skipping."
    return 0
  fi
  ensure_src
  local BUILD; BUILD="$(mktemp -d)"

  # Static libs + GGML_NATIVE=OFF -> one self-contained, portable binary
  # (no -march=native, so it won't SIGILL on older user CPUs).
  local CMAKE_ARGS=(
    -S "$SRC/src" -B "$BUILD"
    -DCMAKE_BUILD_TYPE=Release
    -DBUILD_SHARED_LIBS=OFF
    -DGGML_NATIVE=OFF
    -DGGML_METAL=OFF
    -DWHISPER_BUILD_EXAMPLES=ON
    -DWHISPER_BUILD_TESTS=OFF
    -DWHISPER_BUILD_SERVER=OFF
  )
  if [ "$IS_MAC" = 1 ]; then
    CMAKE_ARGS+=( -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 )
  fi
  if [ "$IS_WIN" = 1 ]; then
    # Link the static CRT so the app doesn't need a VC++ redistributable.
    CMAKE_ARGS+=(
      -DCMAKE_POLICY_DEFAULT_CMP0091=NEW
      -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
    )
    if [ "$WIN_ARCH" = "arm64" ]; then
      # ggml's CPU backend refuses to build with cl.exe on ARM ("MSVC is not
      # supported for ARM, use clang") — clang-cl (ships with the VS "Desktop
      # development with C++" workload) builds it. Select the ARM64 target
      # explicitly so a native ARM64 runner can't fall back to an x64 default.
      CMAKE_ARGS+=( -A ARM64 -T ClangCL )
    else
      CMAKE_ARGS+=( -A x64 )
    fi
  fi

  cmake "${CMAKE_ARGS[@]}"
  cmake --build "$BUILD" --config Release --target whisper-cli -j

  local EXE=""; [ "$IS_WIN" = 1 ] && EXE=".exe"
  local BUILT
  BUILT="$(find "$BUILD" -name "whisper-cli$EXE" -type f | head -n1)"
  [ -n "$BUILT" ] || { echo "[fetch-whisper-cli] build produced no whisper-cli"; exit 1; }

  cp "$BUILT" "$OUT"
  chmod +x "$OUT" 2>/dev/null || true
  rm -rf "$BUILD"

  # macOS: ad-hoc sign the bundled helper so Gatekeeper lets it run.
  if [ "$IS_MAC" = 1 ]; then
    codesign --force --sign - "$OUT" || true
  fi

  # Smoke test. On an ARM64 Windows host an x64 binary still runs under
  # emulation, so both arches can be exercised there; an arm64 binary can't run
  # on an x64 host, so a failure to launch is only fatal when the binary's arch
  # matches the host. The PE-architecture check in scripts/verify-windows-
  # artifact.mjs is the hard gate for the packaged result.
  if "$OUT" --help >/dev/null 2>&1 || "$OUT" -h >/dev/null 2>&1; then
    echo "[fetch-whisper-cli] wrote $OUT ($(du -h "$OUT" | cut -f1))"
  else
    echo "[fetch-whisper-cli] NOTE: $OUT built but did not launch on this host (expected when cross-building an arch this host can't run)."
  fi
}

if [ "$IS_WIN" = 1 ]; then
  build_one "$BIN_DIR/whisper-cli-x64.exe"   x64
  build_one "$BIN_DIR/whisper-cli-arm64.exe" arm64
else
  build_one "$BIN_DIR/whisper-cli"
fi
