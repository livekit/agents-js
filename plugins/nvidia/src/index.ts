// SPDX-FileCopyrightText: Copyright (c) 2026, NVIDIA CORPORATION & AFFILIATES.
// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';

export {
  type EndpointingConfig,
  SpeechStream,
  STT,
  type STTInferenceMode,
  type STTOptions,
  type STTProviderOptions,
} from './stt.js';
export {
  ChunkedStream,
  SynthesizeStream,
  TTS,
  type TTSInferenceMode,
  type TTSOptions,
  type TTSProviderOptions,
} from './tts.js';

class NVIDIAPlugin extends Plugin {
  constructor() {
    super({
      title: 'nvidia',
      version: __PACKAGE_VERSION__,
      package: __PACKAGE_NAME__,
    });
  }
}

Plugin.registerPlugin(new NVIDIAPlugin());
