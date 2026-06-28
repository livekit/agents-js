#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 LiveKit, Inc.
#
# SPDX-License-Identifier: Apache-2.0
#
# Build a minimal, statically-linked, LGPL-licensed ffmpeg binary for one target.
#
# This is the single source of truth for HOW the binaries are built (the .github workflow
# only orchestrates runners + release upload). The configure flags below were validated to
# produce a binary that is:
#   - LGPL v2.1+ only: no --enable-gpl / --enable-nonfree (no x264/x265/fdk-aac).
#   - Relocatable: only system libraries are dynamically linked (--disable-autodetect keeps
#     the build from picking up Homebrew/X11/etc).
#   - Patent-clean: an explicit allowlist of royalty-free audio codecs only. AAC, AC-3,
#     E-AC-3, DTS and all video codecs are excluded — `--disable-everything` followed by
#     enabling exactly the components below. (MP3 is included: its patents expired in 2017.)
#   - Minimal attack surface: --disable-network and no video/device/scaling components,
#     which removes the demuxers/protocols behind most FFmpeg CVEs.
#   - Functional for our needs: decodes mp3/ogg/flac/opus/wav/alac and encodes ogg/opus via
#     the statically-linked libopus (BSD, LGPL-compatible). ~3 MB.
#
# Inputs (env):
#   TARGET          one of: darwin-arm64 darwin-x64 linux-x64 linux-arm64 win32-x64
#   FFMPEG_VERSION  e.g. 7.1.5   (matches an n<version> release tarball at ffmpeg.org)
#   OPUS_VERSION    e.g. 1.5.2
#   OUTPUT_DIR      where the resulting `ffmpeg[.exe]` is copied
#
# The host runner must match TARGET's OS/arch, except win32-x64 which cross-compiles from
# Linux using the mingw-w64 toolchain.
set -euo pipefail

: "${TARGET:?set TARGET}"
: "${FFMPEG_VERSION:?set FFMPEG_VERSION}"
: "${OPUS_VERSION:?set OPUS_VERSION}"
: "${OUTPUT_DIR:?set OUTPUT_DIR}"

WORK="$(mktemp -d)"
PREFIX="$WORK/prefix"
mkdir -p "$PREFIX" "$OUTPUT_DIR"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"

if command -v nproc >/dev/null 2>&1; then JOBS="$(nproc)"; else JOBS="$(sysctl -n hw.ncpu)"; fi

# --- per-target toolchain configuration ---------------------------------------------------
CROSS_FLAGS=()       # extra ffmpeg ./configure flags
OPUS_HOST_FLAGS=()   # extra libopus ./configure flags
OPUS_CFLAGS=""       # extra CFLAGS for the opus build ("" = use opus defaults)
OPUS_LDFLAGS=""      # extra LDFLAGS for the opus build
FF_EXTRA_CFLAGS=""   # appended to ffmpeg --extra-cflags
FF_EXTRA_LDFLAGS=""  # appended to ffmpeg --extra-ldflags
BIN_NAME="ffmpeg"
case "$TARGET" in
  win32-x64)
    CROSS_PREFIX="x86_64-w64-mingw32-"
    CROSS_FLAGS=(--arch=x86_64 --target-os=mingw32 "--cross-prefix=${CROSS_PREFIX}" --pkg-config=pkg-config)
    OPUS_HOST_FLAGS=(--host=x86_64-w64-mingw32 --disable-hardening)
    # Debian/Ubuntu patch their mingw-w64 gcc to default -fstack-protector-strong and
    # _FORTIFY_SOURCE=2. Those inject __stack_chk_*/__memcpy_chk references (normally
    # satisfied by libssp) into libopus.a and the ffmpeg objects, breaking the static link
    # — FFmpeg's opus link test then fails with the misleading "opus not found using
    # pkg-config". Turn both off for the cross build (opus's --disable-hardening alone does
    # not counter the compiler default). Harmless on toolchains that don't default them on.
    OPUS_CFLAGS="-O2 -fno-stack-protector -D_FORTIFY_SOURCE=0"
    FF_EXTRA_CFLAGS="-fno-stack-protector -D_FORTIFY_SOURCE=0"
    BIN_NAME="ffmpeg.exe"
    ;;
  darwin-x64)
    # GitHub's Intel (macos-13) runners are deprecated and queue for hours, so build the
    # x86_64 binary by cross-compiling on the plentiful arm64 (macos-14) runner. macOS clang
    # and the SDK are universal and nasm cross-assembles x86_64 regardless of host. The
    # resulting binary can't be executed here, but the license/patent guards read config
    # headers (no execution), so the pipeline still works end to end.
    CROSS_FLAGS=(--enable-cross-compile --arch=x86_64 --target-os=darwin)
    OPUS_HOST_FLAGS=(--host=x86_64-apple-darwin)
    OPUS_CFLAGS="-arch x86_64"
    OPUS_LDFLAGS="-arch x86_64"
    FF_EXTRA_CFLAGS="-arch x86_64"
    FF_EXTRA_LDFLAGS="-arch x86_64"
    ;;
  darwin-arm64|linux-x64|linux-arm64)
    : # native build on the matching runner
    ;;
  *)
    echo "unsupported TARGET: $TARGET" >&2; exit 1 ;;
esac

cd "$WORK"

echo "::group::build libopus $OPUS_VERSION"
curl -fsSL -o opus.tar.gz "https://downloads.xiph.org/releases/opus/opus-${OPUS_VERSION}.tar.gz"
tar xf opus.tar.gz && cd "opus-${OPUS_VERSION}"
if [ -n "$OPUS_CFLAGS" ]; then export CFLAGS="$OPUS_CFLAGS"; fi
if [ -n "$OPUS_LDFLAGS" ]; then export LDFLAGS="$OPUS_LDFLAGS"; fi
./configure --prefix="$PREFIX" --disable-shared --enable-static --disable-doc \
  --disable-extra-programs ${OPUS_HOST_FLAGS[@]+"${OPUS_HOST_FLAGS[@]}"}
make -j"$JOBS" && make install
unset CFLAGS LDFLAGS # don't leak opus flags into the ffmpeg build (it uses --extra-*flags)
cd "$WORK"
echo "::endgroup::"

echo "::group::build ffmpeg $FFMPEG_VERSION ($TARGET)"
curl -fsSL -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
tar xf ffmpeg.tar.xz && cd "ffmpeg-${FFMPEG_VERSION}"
# Dump config.log on a configure failure — its tail holds the real cause (e.g. a failed
# dependency link test), which the terminal "X not found" message alone does not show.
trap 'status=$?; if [ "$status" -ne 0 ]; then echo "::group::ffbuild/config.log (tail)"; tail -n 60 ffbuild/config.log 2>/dev/null || true; echo "::endgroup::"; fi' EXIT
./configure \
  --prefix="$PREFIX" \
  --pkg-config-flags="--static" \
  --extra-cflags="-I$PREFIX/include $FF_EXTRA_CFLAGS" \
  --extra-ldflags="-L$PREFIX/lib $FF_EXTRA_LDFLAGS" \
  --enable-static --disable-shared \
  --disable-gpl --disable-nonfree \
  --disable-doc --disable-debug --disable-network --disable-autodetect \
  --disable-programs --enable-ffmpeg \
  --disable-everything \
  --enable-protocol=file,pipe,fd \
  --enable-demuxer=wav,w64,aiff,au,caf,mp3,flac,ogg,matroska,mov,pcm_s16le,pcm_s16be,pcm_f32le,pcm_mulaw,pcm_alaw \
  --enable-decoder=pcm_s16le,pcm_s16be,pcm_s24le,pcm_s32le,pcm_u8,pcm_f32le,pcm_f32be,pcm_alaw,pcm_mulaw,mp3,mp3float,flac,vorbis,opus,libopus,alac \
  --enable-parser=mpegaudio,flac,vorbis,opus \
  --enable-encoder=libopus,pcm_s16le,flac \
  --enable-muxer=ogg,wav,flac,pcm_s16le,null \
  --enable-filter=aresample,aformat,anull,abuffer,abuffersink \
  --enable-libopus \
  ${CROSS_FLAGS[@]+"${CROSS_FLAGS[@]}"}
trap - EXIT # configure succeeded; stop watching for its config.log
make -j"$JOBS"
echo "::endgroup::"

# --- verify the result before publishing --------------------------------------------------
# License guard: config.h is authoritative (the printed "License:" line is stdout-only) and
# works for cross-compiled targets. A GPL/nonfree build sets CONFIG_GPL/CONFIG_NONFREE to 1.
if grep -qE "^#define CONFIG_(GPL|NONFREE) 1" config.h; then
  echo "ERROR: build is GPL/nonfree (CONFIG_GPL/CONFIG_NONFREE enabled) — refusing to publish" >&2
  exit 1
fi
echo "license ok: LGPL (CONFIG_GPL=0, CONFIG_NONFREE=0)"

# Patent guard: assert no encumbered codec slipped into the build. Reads the generated
# component config (works for cross-compiled targets where we cannot run the binary).
# FFmpeg 7.x defines CONFIG_*_DECODER in config_components.h; older versions use config.h.
CONFIG_HDR="config_components.h"; [ -f "$CONFIG_HDR" ] || CONFIG_HDR="config.h"
for codec in AAC AC3 EAC3 DCA; do
  if grep -qE "^#define CONFIG_${codec}_DECODER 1" "$CONFIG_HDR"; then
    echo "ERROR: patent-encumbered ${codec} decoder is enabled — refusing to publish" >&2
    exit 1
  fi
done
echo "patent guard ok: no aac/ac3/eac3/dca decoders"

cp "$BIN_NAME" "$OUTPUT_DIR/$BIN_NAME"
echo "built $OUTPUT_DIR/$BIN_NAME"
ls -lh "$OUTPUT_DIR/$BIN_NAME"
