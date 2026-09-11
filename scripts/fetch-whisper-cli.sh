#!/usr/bin/env bash
#
# Build whisper.cpp's `whisper-cli` for the host platform and drop it in `bin/`
# so it ships inside the packaged app (see `build.extraResources` and
# `resolveWhisperCli()` in electron/main.ts). Without this the app can't
# transcribe unless the user installs whisper.cpp themselves.
#
# Idempotent: a no-op if `bin/whisper-cli[.exe]` is already there. Runs from
# CI on each matrix runner (bash is available on the Windows runners too) and
# can be run locally before `npm run dist`.
#
# Pin the source with WHISPER_CPP_REF; skip entirely with SKIP_WHISPER_CLI=1.
set -euo pipefail

WHISPER_CPP_REF="${WHISPER_CPP_REF:-v1.9.3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/bin"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) EXE=".exe" ; IS_WIN=1 ;;
  *) EXE="" ; IS_WIN=0 ;;
esac
IS_MAC=0; [ "$(uname -s)" = "Darwin" ] && IS_MAC=1
OUT="$BIN_DIR/whisper-cli$EXE"

if [ "${SKIP_WHISPER_CLI:-}" = "1" ]; then
  echo "[fetch-whisper-cli] SKIP_WHISPER_CLI=1 — skipping."
  exit 0
fi
if [ -f "$OUT" ]; then
  echo "[fetch-whisper-cli] $OUT already present — skipping."
  exit 0
fi

mkdir -p "$BIN_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[fetch-whisper-cli] cloning whisper.cpp $WHISPER_CPP_REF"
git clone --depth 1 --branch "$WHISPER_CPP_REF" \
  https://github.com/ggml-org/whisper.cpp "$WORK/src"

# Static libs + GGML_NATIVE=OFF -> one self-contained, portable binary
# (no -march=native, so it won't SIGILL on older user CPUs).
CMAKE_ARGS=(
  -S "$WORK/src" -B "$WORK/build"
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
  # ggml's CPU backend refuses to build with cl.exe on ARM64 ("MSVC is not
  # supported for ARM, use clang") — switch the Visual Studio generator's
  # toolset to clang-cl, which ships with the VS "Desktop development with
  # C++" workload on the windows-11-arm runner. x64 keeps plain cl.exe.
  #
  # Arch comes from WHISPER_CLI_WIN_ARCH (set by CI from the job matrix) —
  # PROCESSOR_ARCHITECTURE isn't trustworthy here: Git Bash on the
  # windows-11-arm runner can run under WOW64 emulation, in which case that
  # var reports the emulated arch and the real one only shows up in
  # PROCESSOR_ARCHITEW6432. Fall back to checking both for local/manual runs.
  IS_ARM64_WIN=0
  if [ -n "${WHISPER_CLI_WIN_ARCH:-}" ]; then
    [ "$WHISPER_CLI_WIN_ARCH" = "arm64" ] && IS_ARM64_WIN=1
  else
    case "${PROCESSOR_ARCHITEW6432:-${PROCESSOR_ARCHITECTURE:-}}" in
      ARM64) IS_ARM64_WIN=1 ;;
    esac
  fi
  if [ "$IS_ARM64_WIN" = 1 ]; then
    CMAKE_ARGS+=( -T ClangCL )
  fi
fi

cmake "${CMAKE_ARGS[@]}"
cmake --build "$WORK/build" --config Release --target whisper-cli -j

BUILT="$(find "$WORK/build" -name "whisper-cli$EXE" -type f | head -n1)"
[ -n "$BUILT" ] || { echo "[fetch-whisper-cli] build produced no whisper-cli"; exit 1; }

cp "$BUILT" "$OUT"
chmod +x "$OUT" 2>/dev/null || true

# macOS: ad-hoc sign the bundled helper so Gatekeeper lets it run. The app
# bundle is ad-hoc signed too (build.mac.identity "-").
if [ "$IS_MAC" = 1 ]; then
  codesign --force --sign - "$OUT" || true
fi

# Smoke test.
"$OUT" --help >/dev/null 2>&1 || "$OUT" -h >/dev/null 2>&1 || {
  echo "[fetch-whisper-cli] built binary did not run"; exit 1;
}
echo "[fetch-whisper-cli] wrote $OUT ($(du -h "$OUT" | cut -f1))"
