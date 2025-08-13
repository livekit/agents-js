// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { InferenceRunner } from '@livekit/agents';
import { INFERENCE_METHOD_EN } from './english.js';
import { INFERENCE_METHOD_MULTILINGUAL } from './multilingual.js';

export { EOUModel } from './base.js';
export { EnglishModel } from './english.js';
export { MultilingualModel } from './multilingual.js';
export { getUnicodeCategory, normalizeText } from './utils.js';

InferenceRunner.registerRunner(
  INFERENCE_METHOD_EN,
  new URL('./english.js', import.meta.url).toString(),
);

InferenceRunner.registerRunner(
  INFERENCE_METHOD_MULTILINGUAL,
  new URL('./multilingual.js', import.meta.url).toString(),
);
