// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '@livekit/agents';
import { z } from 'zod';

const DEFAULT_VOICE = 'fishaudio';

interface Voice {
  provider: string;
  model: string;
  voice: string;
  label: string;
}

const VOICES = {
  fishaudio: {
    provider: 'fishaudio',
    model: 'fishaudio/s2.1-pro',
    voice: '51b44863613e405a896f7f4294c6e6d0',
    label: 'Fish Audio S2.1 Pro (Marley)',
  },
  inworld: {
    provider: 'inworld',
    model: 'inworld/inworld-tts-2',
    voice: 'Ashley',
    label: 'Inworld TTS 2 (Ashley)',
  },
  cartesia: {
    provider: 'cartesia',
    model: 'cartesia/sonic-3',
    voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
    label: 'Cartesia Sonic 3 (Jacqueline)',
  },
  xai: {
    provider: 'xai',
    model: 'xai/tts-1',
    voice: 'eve',
    label: 'xAI TTS 1 (Eve)',
  },
} as const satisfies Record<string, Voice>;

const boolSchema = z.preprocess((value) => {
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return value;
}, z.boolean());

const requestSchema = z.object({
  expressive: boolSchema.default(true),
  tts: z.string().optional(),
});

export interface SessionConfig {
  expressive: boolean;
  voice: Voice;
  attributes(): Record<string, string>;
}

export function parseSessionConfig(metadata?: string): SessionConfig {
  let request: z.infer<typeof requestSchema> = { expressive: true };

  if (metadata) {
    try {
      const result = requestSchema.safeParse(JSON.parse(metadata));
      if (!result.success) throw result.error;
      request = result.data;
    } catch {
      log().warn({ metadata }, 'ignoring malformed expressive-agent dispatch metadata');
    }
  }

  const requestedVoice = request.tts as keyof typeof VOICES | undefined;
  const voice = VOICES[requestedVoice ?? DEFAULT_VOICE] ?? VOICES[DEFAULT_VOICE];

  return {
    expressive: request.expressive,
    voice,
    attributes: () => ({
      expressive: request.expressive ? 'true' : 'false',
      tts_provider: voice.provider,
      tts_label: voice.label,
    }),
  };
}
