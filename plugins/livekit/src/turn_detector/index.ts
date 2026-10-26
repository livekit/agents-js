// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { InferenceRunner } from '@livekit/agents';
import { extname } from 'node:path';
import { INFERENCE_METHOD_EN } from './english.js';
import { INFERENCE_METHOD_MULTILINGUAL } from './multilingual.js';

console.warn(
  'The text-based turn detector from @livekit/agents-plugin-livekit is deprecated. ' +
    'The audio EOT detector in `@livekit/agents` inference (TurnDetector) replaces ' +
    'it and runs natively on-device via @livekit/local-inference. ' +
    'This text-based path will be removed in a future release.',
);

export { EOUModel } from './base.js';
export { EnglishModel } from './english.js';
export { MultilingualModel } from './multilingual.js';
export { getUnicodeCategory, normalizeText } from './utils.js';

const currentFileExtension = extname(import.meta.url);

InferenceRunner.registerRunner(
  INFERENCE_METHOD_EN,
  new URL(`./english${currentFileExtension}`, import.meta.url).toString(),
);

InferenceRunner.registerRunner(
  INFERENCE_METHOD_MULTILINGUAL,
  new URL(`./multilingual${currentFileExtension}`, import.meta.url).toString(),
);
