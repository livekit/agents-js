// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export {
  SAMPLE_RATE_8K,
  SAMPLE_RATE_16K,
  SpeechStream,
  STT,
  type GnaniSTTFormat,
  type GnaniSTTLanguages,
  type ResolvedSTTOptions,
  type STTOptions,
} from './stt.js';
export {
  RESTChunkedStream,
  SSEChunkedStream,
  SynthesizeStream,
  TTS,
  WebSocketChunkedStream,
  type ChunkedStream,
  type GnaniTTSBitrates,
  type GnaniTTSContainers,
  type GnaniTTSEncodings,
  type GnaniTTSSynthesizeMethod,
  type GnaniTTSVoices,
  type ResolvedTTSOptions,
  type TTSOptions,
  type TTSUpdateOptions,
} from './tts.js';

class GnaniPlugin extends Plugin {
  constructor() {
    super({
      title: 'gnani',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new GnaniPlugin());
