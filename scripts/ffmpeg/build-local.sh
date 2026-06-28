#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 LiveKit, Inc.
#
# SPDX-License-Identifier: Apache-2.0
#
# Convenience wrapper for local development: build the bundled LGPL ffmpeg binary for THIS
# machine and install it into agents/.ffmpeg/, so local runs use the same binary that ships
# (instead of falling back to whatever `ffmpeg` happens to be on PATH).
#
# It detects the host OS/arch, reads the pinned FFmpeg/libopus versions from the single
# source of truth (scripts/ffmpeg/release.mjs), and delegates to build-ffmpeg.sh.
#
# Usage:  pnpm ffmpeg:local      (or: bash scripts/ffmpeg/build-local.sh)
#
# Requires a C toolchain. macOS: `brew install nasm pkg-config automake autoconf libtool`
# (nasm only needed for x86_64). Linux: `nasm yasm pkg-config build-essential`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Map the host OS/arch to a build target understood by build-ffmpeg.sh.
os="$(uname -s)"
arch="$(uname -m)"
case "$os/$arch" in
  Darwin/arm64) TARGET=darwin-arm64 ;;
  Darwin/x86_64) TARGET=darwin-x64 ;;
  Linux/x86_64) TARGET=linux-x64 ;;
  Linux/aarch64 | Linux/arm64) TARGET=linux-arm64 ;;
  *)
    echo "build-local: unsupported host '$os/$arch'." >&2
    echo "Windows binaries are cross-compiled in CI (TARGET=win32-x64 from Linux); there is" >&2
    echo "no native local build. Set LIVEKIT_FFMPEG_PATH to your own ffmpeg.exe instead." >&2
    exit 1
    ;;
esac

# Pull versions from the single source of truth so a local build matches CI/releases exactly.
versions="$(node -e "import('${REPO_ROOT}/scripts/ffmpeg/release.mjs').then(m => console.log(m.FFMPEG_VERSION, m.OPUS_VERSION))")"
FFMPEG_VERSION="${versions%% *}"
OPUS_VERSION="${versions##* }"

OUTPUT_DIR="${REPO_ROOT}/agents/.ffmpeg"
echo "build-local: building ffmpeg ${FFMPEG_VERSION} (libopus ${OPUS_VERSION}) for ${TARGET}"
echo "build-local: installing into ${OUTPUT_DIR}"

TARGET="$TARGET" \
  FFMPEG_VERSION="$FFMPEG_VERSION" \
  OPUS_VERSION="$OPUS_VERSION" \
  OUTPUT_DIR="$OUTPUT_DIR" \
  bash "${SCRIPT_DIR}/build-ffmpeg.sh"

echo "build-local: done — @livekit/agents will now resolve ${OUTPUT_DIR}/ffmpeg with no env set."
