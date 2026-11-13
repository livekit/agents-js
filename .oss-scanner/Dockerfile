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

# Download only the turn detector's assets; any failure must stop the build.
RUN cd plugins/livekit && node --input-type=module <<'JS'
import { AutoTokenizer } from '@huggingface/transformers';
import { Plugin, initializeLogger } from '@livekit/agents';
import './dist/index.js';

initializeLogger({ pretty: false });
for (const plugin of Plugin.registeredPlugins) {
    if (plugin.package === '@livekit/agents-plugin-livekit') {
        await plugin.downloadFiles();
    }
}
// Transformers.js 4.2 probes tokenizer metadata at main even for a pinned revision.
await AutoTokenizer.from_pretrained('livekit/turn-detector');
JS

# Load both models, tokenizers, and language files without network access.
RUN --network=none cd plugins/livekit && node --input-type=module <<'JS'
import { initializeLogger } from '@livekit/agents';
import { readFileSync } from 'node:fs';
import { downloadFileToCacheDir } from './dist/index.js';
import { HG_MODEL_REPO, MODEL_REVISIONS } from './dist/turn_detector/constants.js';
import { EOURunnerEn } from './dist/turn_detector/english.js';
import { EUORunnerMultilingual } from './dist/turn_detector/multilingual.js';

initializeLogger({ pretty: false });
for (const revision of Object.values(MODEL_REVISIONS)) {
    const path = await downloadFileToCacheDir({
        repo: HG_MODEL_REPO, path: 'languages.json', revision, localFileOnly: true,
    });
    JSON.parse(readFileSync(path, 'utf8'));
}
for (const Runner of [EOURunnerEn, EUORunnerMultilingual]) {
    const runner = new Runner();
    try {
        await runner.initialize();
    } finally {
        await runner.close();
    }
}
JS

ENV npm_config_offline=true \
    pnpm_config_offline=true

# The test.yml subset that runs without provider keys; inference tests skip unless LIVEKIT_INFERENCE_TESTS=1.
RUN timeout 20m pnpm test agents/src plugins/openai/src/realtime plugins/xai/src/realtime --silent \
    || echo 'WARNING: baseline tests failed'

CMD ["bash"]
