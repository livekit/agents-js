// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';
import { downloadFileToCacheDir as hfDownload } from './hf_utils.js';
import { HG_MODEL_REPO, MODEL_REVISIONS, ONNX_FILEPATH } from './turn_detector/constants.js';

export { downloadFileToCacheDir } from './hf_utils.js';
export * as turnDetector from './turn_detector/index.js';

class EOUPlugin extends Plugin {
  constructor() {
    super({
      title: 'turn-detector',
      version: '0.1.1',
      package: '@livekit/agents-plugin-livekit',
    });
  }

  async downloadFiles(): Promise<void> {
    const { AutoTokenizer } = await import('@huggingface/transformers');

    for (const revision of Object.values(MODEL_REVISIONS)) {
      // Ensure tokenizer is cached
      await AutoTokenizer.from_pretrained(HG_MODEL_REPO, { revision });

      // Ensure ONNX model and language data are cached
      await hfDownload({ repo: HG_MODEL_REPO, path: ONNX_FILEPATH, revision });
      await hfDownload({ repo: HG_MODEL_REPO, path: 'languages.json', revision });
    }
  }
}

Plugin.registerPlugin(new EOUPlugin());
