# SPDX-FileCopyrightText: 2026 LiveKit, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Build image for Anthropic's OSS Scanner. CI pins only Node's major version (setup-node `node-version: 24`).
FROM node:24-bookworm

ENV CI=true

RUN apt-get update && apt-get install -y --no-install-recommends git-lfs \
    && rm -rf /var/lib/apt/lists/*

# Match package.json's packageManager exactly: on a mismatch pnpm downloads that version, which fails offline.
RUN npm install -g pnpm@11.13.1 && pnpm --version

WORKDIR /src
COPY . /src

# A plain clone leaves LFS files (silero_vad.onnx, plugins/test/src/long.wav) as pointers. The CI test subset doesn't read them.
RUN (git lfs install --local --force && git lfs pull) || echo 'WARNING: git lfs pull failed; model and audio files are pointers'; \
    git config --local filter.lfs.required false

# --ignore-scripts as in CI: native addons ship prebuilt in per-platform optionalDependencies or the package itself.
RUN pnpm install --frozen-lockfile --ignore-scripts
# Each package's tsc takes about 1 GB; turbo's default parallelism runs out of memory on small builders.
ARG BUILD_CONCURRENCY=4
RUN pnpm exec turbo run build --concurrency=${BUILD_CONCURRENCY}

# The turn detector loads its model and tokenizer only from local caches at runtime.
# download-files exits non-zero if any plugin fails to import, so check for the model instead.
RUN (cd examples && node ../agents/dist/bin/livekit-agents.js download-files) \
        || echo 'WARNING: download-files reported failures'; \
    test -d /root/.cache/huggingface/hub/models--livekit--turn-detector

ENV npm_config_offline=true \
    pnpm_config_offline=true

# The test.yml subset that runs without provider keys; inference tests skip unless LIVEKIT_INFERENCE_TESTS=1.
RUN timeout 20m pnpm test agents/src plugins/openai/src/realtime plugins/xai/src/realtime --silent \
    || echo 'WARNING: baseline tests failed'

CMD ["bash"]
