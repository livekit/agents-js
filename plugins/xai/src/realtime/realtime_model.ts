// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { realtime } from '@livekit/agents-plugin-openai';

const { RealtimeModel: OpenAIRealtimeModel } = realtime;
type OpenAIRealtimeModelOptions = ConstructorParameters<typeof OpenAIRealtimeModel>[0];

const XAI_BASE_URL = 'wss://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-4-1-fast-non-reasoning';
const DEFAULT_VOICE = 'Ara';

const XAI_DEFAULT_TURN_DETECTION = {
  type: 'server_vad' as const,
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 200,
  create_response: true,
  interrupt_response: true,
};

export type GrokVoices = 'Ara' | 'Cora' | 'Sage';

export interface RealtimeModelOptions extends Omit<OpenAIRealtimeModelOptions, 'model'> {
  model?: string;
  voice?: GrokVoices | string;
  apiKey?: string;
}

export class RealtimeModel extends OpenAIRealtimeModel {
  constructor(options: RealtimeModelOptions = {}) {
    super({
      baseURL: XAI_BASE_URL,
      model: DEFAULT_MODEL,
      voice: options.voice || DEFAULT_VOICE,
      apiKey: options.apiKey || process.env.XAI_API_KEY,
      modalities: ['audio'],
      turnDetection: XAI_DEFAULT_TURN_DETECTION,
      ...options,
    });
  }
}
