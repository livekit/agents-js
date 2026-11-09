// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  type AudioBuffer,
  stt as coreStt,
  delay,
} from '@livekit/agents';
import { stt } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';
import { STT, _isProviderProgressEvent } from './stt.js';

const hasMistralApiKey = Boolean(process.env.MISTRAL_API_KEY);

if (hasMistralApiKey) {
  describe('Mistral STT', { timeout: 30_000 }, async () => {
    await stt(new STT({ model: 'voxtral-mini-transcribe-3' }), undefined, {
      streaming: false,
    });
  });
} else {
  describe('Mistral STT', () => {
    it.skip('requires MISTRAL_API_KEY', () => {});
  });
}

function frame(): AudioFrame {
  return new AudioFrame(new Int16Array(1600), 16_000, 1, 1600);
}

function fakeSTT(requests: Record<string, unknown>[], language?: string): STT {
  const client = {
    audio: {
      transcriptions: {
        complete: async (request: Record<string, unknown>) => {
          requests.push(request);
          return { text: 'hello', segments: [] };
        },
      },
    },
  };
  return new STT({
    client: client as never,
    model: 'voxtral-mini-2602',
    language,
  });
}

describe('Mistral STT recognize options', () => {
  it('applies a language override to one call', async () => {
    const requests: Record<string, unknown>[] = [];
    const mistral = fakeSTT(requests, 'en');
    const audio: AudioBuffer = [frame()];

    const overridden = await mistral.recognize(audio, { language: 'fr' });
    const defaultResult = await mistral.recognize(audio);

    expect(requests.map((request) => request.language)).toEqual(['fr', 'en']);
    expect(overridden.alternatives?.[0].language).toBe('fr');
    expect(defaultResult.alternatives?.[0].language).toBe('en');
  });

  it('keeps automatic language detection after an override', async () => {
    const requests: Record<string, unknown>[] = [];
    const mistral = fakeSTT(requests);
    const audio: AudioBuffer = [frame()];

    await mistral.recognize(audio, { language: 'fr' });
    await mistral.recognize(audio);

    expect(requests[0]?.language).toBe('fr');
    expect(requests[0]?.timestampGranularities).toEqual(['segment']);
    expect(requests[1]?.language).toBeUndefined();
    expect(requests[1]?.timestampGranularities).toEqual(['segment']);
  });
});

class ProviderProgressSTT extends coreStt.STT {
  label = 'mistral-provider-progress-test';

  constructor(private readonly eventType: string) {
    super({ streaming: true, interimResults: true });
  }

  protected async _recognize(_buffer: AudioBuffer): Promise<coreStt.SpeechEvent> {
    throw new APIConnectionError({ message: 'not used' });
  }

  stream(options?: { connOptions?: APIConnectOptions }): ProviderProgressStream {
    return new ProviderProgressStream(this, this.eventType, options?.connOptions);
  }
}

class ProviderProgressStream extends coreStt.SpeechStream {
  label = 'mistral-provider-progress-stream-test';
  runCount = 0;

  constructor(
    stt: coreStt.STT,
    private readonly eventType: string,
    options?: APIConnectOptions,
  ) {
    super(stt, undefined, options);
  }

  protected async run(): Promise<void> {
    this.runCount += 1;
    if (this.runCount === 2 && _isProviderProgressEvent(this.eventType)) {
      this.markProviderProgress();
    }
    if (this.runCount <= 2) {
      throw new APIConnectionError({ message: 'connection dropped' });
    }
    for await (const _ of this.input) {
      // Keep the successful third attempt open until the assertion completes.
    }
  }
}

describe('Mistral STT provider progress', () => {
  it.each([
    ['transcription.language', 3],
    ['session.created', 2],
  ])('resets retries for %s', async (eventType, expectedRuns) => {
    const stream = new ProviderProgressSTT(eventType).stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 10_000 },
    });
    try {
      while (stream.runCount < expectedRuns && !stream.terminalError) await delay(1);
      expect(stream.runCount).toBe(expectedRuns);
    } finally {
      stream.close();
    }
  });
});
