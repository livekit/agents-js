// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as realtime from '../realtime/index.js';

export {
  TTS,
  type CustomPronunciationParams,
  type CustomPronunciations,
  type GeminiTTSModels,
  type GeminiVoices,
  type TTSOptions,
} from './gemini_tts.js';

/**
 * @deprecated Use the top-level `realtime` export instead (e.g. `google.realtime.RealtimeModel`).
 * Re-exported here for backward compatibility.
 */
export { realtime };
