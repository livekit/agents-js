// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as eot from './eot/index.js';
import * as llm from './llm.js';
import * as stt from './stt.js';
import * as tts from './tts.js';

export { eot };
export {
  AudioTurnDetector,
  AudioTurnDetectorStreamImpl,
  CLOUD_LANGUAGES,
  LOCAL_LANGUAGES,
  CloudTransport,
  LocalTransport,
  materializeThresholds,
  rescaleForLocalFallback,
  type AudioTurnDetectorOptions,
  type Backend,
  type CloudTransportOptions,
} from './eot/index.js';

export { VAD, type VADOptions, type VADModels } from './vad.js';

export {
  LLM,
  LLMStream,
  type ChatCompletionOptions,
  type GatewayOptions,
  type InferenceClass,
  type InferenceLLMOptions,
  type LLMModels,
  type XAIModels,
} from './llm.js';

export {
  normalizeSTTFallback,
  parseSTTModelString,
  STT,
  type STTFallbackModel,
  type STTFallbackModelType,
  type STTLanguages,
  type STTModels,
  type ModelWithLanguage as STTModelString,
  type STTOptions,
  type XaiSTTModels,
  type XaiOptions as XaiSTTOptions,
} from './stt.js';

export {
  normalizeTTSFallback,
  parseTTSModelString,
  TTS,
  type TTSFallbackModel,
  type TTSFallbackModelType,
  type TTSModels,
  type ModelWithVoice as TTSModelString,
  type TTSOptions,
} from './tts.js';

export { llm, stt, tts };
