// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import * as agents from '../index.js';
import { normalizeLanguage } from '../language.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { VAD, type VADStream } from '../vad.js';
import {
  SpeechStream as InferenceSpeechStream,
  STT,
  type STTFallbackModel,
  type STTModels,
  type XaiSTTModels,
  normalizeSTTFallback,
  parseSTTModelString,
} from './stt.js';
import { describeLiveKitInference } from './test_utils.js';
import { VAD as InferenceVAD } from './vad.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

/** Helper to create STT with required credentials. */
function makeStt(overrides: Record<string, unknown> = {}) {
  const defaults = {
    model: 'deepgram' as const,
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: 'https://example.livekit.cloud',
  };
  return new STT({ ...defaults, ...overrides });
}

function makeSpeechStream() {
  const events: SpeechEvent[] = [];
  const stream = Object.assign(Object.create(InferenceSpeechStream.prototype), {
    queue: {
      closed: false,
      put: (event: SpeechEvent) => events.push(event),
    },
    speaking: false,
    requestId: 'req-1',
    speechDuration: 0,
    _startTimeOffset: 0,
    _pendingExtra: undefined,
    opts: { language: 'en' },
  }) as InferenceSpeechStream<STTModels>;
  return { stream, events };
}

function transcript(transcript: string, isFinal = false) {
  return {
    type: isFinal ? ('final_transcript' as const) : ('interim_transcript' as const),
    transcript,
    language: 'en',
    start: 0,
    duration: isFinal ? 1 : 0,
    confidence: 1,
    words: [],
  };
}

describe('Inference STT start of speech', () => {
  it('reports onset immediately from a start_of_speech message', () => {
    const { stream, events } = makeSpeechStream();

    stream['processStartOfSpeech']();

    expect(events.map(({ type }) => type)).toEqual([SpeechEventType.START_OF_SPEECH]);
    expect(stream._speaking).toBe(true);
  });

  it('does not report onset twice when a transcript follows', () => {
    const { stream, events } = makeSpeechStream();

    stream['processStartOfSpeech']();
    expect(events.splice(0).map(({ type }) => type)).toEqual([SpeechEventType.START_OF_SPEECH]);

    stream['processTranscript'](transcript('are you'), SpeechEventType.INTERIM_TRANSCRIPT);

    expect(events.map(({ type }) => type)).toEqual([SpeechEventType.INTERIM_TRANSCRIPT]);
  });

  it('ignores a duplicate start_of_speech message', () => {
    const { stream, events } = makeSpeechStream();

    stream['processStartOfSpeech']();
    stream['processStartOfSpeech']();

    expect(events.map(({ type }) => type)).toEqual([SpeechEventType.START_OF_SPEECH]);
  });

  it('falls back to the first transcript for providers without onset', () => {
    const { stream, events } = makeSpeechStream();

    stream['processTranscript'](transcript('are you'), SpeechEventType.INTERIM_TRANSCRIPT);

    expect(events.map(({ type }) => type)).toEqual([
      SpeechEventType.START_OF_SPEECH,
      SpeechEventType.INTERIM_TRANSCRIPT,
    ]);
  });

  it('does not report onset from an empty interim alone', () => {
    const { stream, events } = makeSpeechStream();

    stream['processTranscript'](transcript(''), SpeechEventType.INTERIM_TRANSCRIPT);

    expect(events).toEqual([]);
    expect(stream._speaking).toBe(false);
  });

  it('resets onset after the turn ends', () => {
    const { stream, events } = makeSpeechStream();

    stream['processStartOfSpeech']();
    stream['processTranscript'](
      transcript('are you open on sunday', true),
      SpeechEventType.FINAL_TRANSCRIPT,
    );
    expect(stream._speaking).toBe(false);

    stream['processStartOfSpeech']();
    expect(events.map(({ type }) => type)).toContain(SpeechEventType.START_OF_SPEECH);
  });
});

describe('parseSTTModelString', () => {
  it('simple model without language', () => {
    const [model, language] = parseSTTModelString('deepgram');
    expect(model).toBe('deepgram');
    expect(language).toBeUndefined();
  });

  it('model with language suffix', () => {
    const [model, language] = parseSTTModelString('deepgram:en');
    expect(model).toBe('deepgram');
    expect(language).toBe('en');
  });

  it('normalizes language suffixes', () => {
    const [model, language] = parseSTTModelString('deepgram:english');
    expect(model).toBe('deepgram');
    expect(language).toBe('en');
  });

  it('provider/model format without language', () => {
    const [model, language] = parseSTTModelString('deepgram/nova-3');
    expect(model).toBe('deepgram/nova-3');
    expect(language).toBeUndefined();
  });

  it('provider/model format with language', () => {
    const [model, language] = parseSTTModelString('deepgram/nova-3:en');
    expect(model).toBe('deepgram/nova-3');
    expect(language).toBe('en');
  });

  it.each([
    ['cartesia/ink-whisper:de', 'cartesia/ink-whisper', 'de'],
    ['assemblyai:es', 'assemblyai', 'es'],
    ['deepgram/nova-2-medical:ja', 'deepgram/nova-2-medical', 'ja'],
    ['deepgram/nova-3:multi', 'deepgram/nova-3', 'multi'],
    ['cartesia:zh', 'cartesia', 'zh'],
  ])('various providers and languages: %s', (modelStr, expectedModel, expectedLang) => {
    const [model, language] = parseSTTModelString(modelStr);
    expect(model).toBe(expectedModel);
    expect(language).toBe(expectedLang);
  });

  it('auto model without language', () => {
    const [model, language] = parseSTTModelString('auto');
    expect(model).toBe('auto');
    expect(language).toBeUndefined();
  });

  it('auto model with language', () => {
    const [model, language] = parseSTTModelString('auto:pt');
    expect(model).toBe('auto');
    expect(language).toBe('pt');
  });
});

describe('normalizeSTTFallback', () => {
  it('single string model', () => {
    const result = normalizeSTTFallback('deepgram/nova-3');
    expect(result).toEqual([{ model: 'deepgram/nova-3' }]);
  });

  it('single FallbackModel dict', () => {
    const fallback: STTFallbackModel = { model: 'deepgram/nova-3' };
    const result = normalizeSTTFallback(fallback);
    expect(result).toEqual([{ model: 'deepgram/nova-3' }]);
  });

  it('list of string models', () => {
    const result = normalizeSTTFallback(['deepgram/nova-3', 'cartesia/ink-whisper']);
    expect(result).toEqual([{ model: 'deepgram/nova-3' }, { model: 'cartesia/ink-whisper' }]);
  });

  it('list of FallbackModel dicts', () => {
    const fallbacks: STTFallbackModel[] = [{ model: 'deepgram/nova-3' }, { model: 'assemblyai' }];
    const result = normalizeSTTFallback(fallbacks);
    expect(result).toEqual([{ model: 'deepgram/nova-3' }, { model: 'assemblyai' }]);
  });

  it('mixed list of strings and dicts', () => {
    const result = normalizeSTTFallback([
      'deepgram/nova-3',
      { model: 'cartesia/ink-whisper' } as STTFallbackModel,
      'assemblyai',
    ]);
    expect(result).toEqual([
      { model: 'deepgram/nova-3' },
      { model: 'cartesia/ink-whisper' },
      { model: 'assemblyai' },
    ]);
  });

  it('string with language suffix discards language', () => {
    const result = normalizeSTTFallback('deepgram/nova-3:en');
    expect(result).toEqual([{ model: 'deepgram/nova-3' }]);
  });

  it('FallbackModel with extraKwargs is preserved', () => {
    const fallback: STTFallbackModel = {
      model: 'deepgram/nova-3',
      extraKwargs: { keywords: [['livekit', 1.5]], punctuate: true },
    };
    const result = normalizeSTTFallback(fallback);
    expect(result).toEqual([
      {
        model: 'deepgram/nova-3',
        extraKwargs: { keywords: [['livekit', 1.5]], punctuate: true },
      },
    ]);
  });

  it('list with extraKwargs preserved', () => {
    const result = normalizeSTTFallback([
      { model: 'deepgram/nova-3', extraKwargs: { punctuate: true } } as STTFallbackModel,
      'cartesia/ink-whisper',
      { model: 'assemblyai', extraKwargs: { format_turns: true } } as STTFallbackModel,
    ]);
    expect(result).toEqual([
      { model: 'deepgram/nova-3', extraKwargs: { punctuate: true } },
      { model: 'cartesia/ink-whisper' },
      { model: 'assemblyai', extraKwargs: { format_turns: true } },
    ]);
  });

  it('empty list returns empty list', () => {
    const result = normalizeSTTFallback([]);
    expect(result).toEqual([]);
  });

  it('multiple colons in model string splits on last', () => {
    const result = normalizeSTTFallback('some:model:part:fr');
    expect(result).toEqual([{ model: 'some:model:part' }]);
  });
});

describe('STT constructor fallback and connOptions', () => {
  it('normalizes language in constructor and model string', () => {
    const stt = makeStt({ model: 'deepgram/nova-3:english' });
    expect(stt['opts'].language).toBe('en');
  });

  it('prefers explicit normalized language over model suffix', () => {
    const stt = makeStt({ model: 'deepgram/nova-3:english', language: 'en_US' });
    expect(stt['opts'].language).toBe(normalizeLanguage('en_US'));
  });

  it('fallback not given defaults to undefined', () => {
    const stt = makeStt();
    expect(stt['opts'].fallback).toBeUndefined();
  });

  it('fallback single string is normalized', () => {
    const stt = makeStt({ fallback: 'cartesia/ink-whisper' });
    expect(stt['opts'].fallback).toEqual([{ model: 'cartesia/ink-whisper' }]);
  });

  it('fallback list of strings is normalized', () => {
    const stt = makeStt({ fallback: ['deepgram/nova-3', 'assemblyai'] });
    expect(stt['opts'].fallback).toEqual([{ model: 'deepgram/nova-3' }, { model: 'assemblyai' }]);
  });

  it('fallback single FallbackModel is normalized to list', () => {
    const stt = makeStt({ fallback: { model: 'deepgram/nova-3' } });
    expect(stt['opts'].fallback).toEqual([{ model: 'deepgram/nova-3' }]);
  });

  it('fallback with extraKwargs is preserved', () => {
    const stt = makeStt({
      fallback: {
        model: 'deepgram/nova-3',
        extraKwargs: { punctuate: true, keywords: [['livekit', 1.5]] },
      },
    });
    expect(stt['opts'].fallback).toEqual([
      {
        model: 'deepgram/nova-3',
        extraKwargs: { punctuate: true, keywords: [['livekit', 1.5]] },
      },
    ]);
  });

  it('fallback mixed list is normalized', () => {
    const stt = makeStt({
      fallback: [
        'deepgram/nova-3',
        { model: 'cartesia', extraKwargs: { min_volume: 0.5 } },
        'assemblyai',
      ],
    });
    expect(stt['opts'].fallback).toEqual([
      { model: 'deepgram/nova-3' },
      { model: 'cartesia', extraKwargs: { min_volume: 0.5 } },
      { model: 'assemblyai' },
    ]);
  });

  it('fallback string with language discards language', () => {
    const stt = makeStt({ fallback: 'deepgram/nova-3:en' });
    expect(stt['opts'].fallback).toEqual([{ model: 'deepgram/nova-3' }]);
  });

  it('connOptions not given uses default', () => {
    const stt = makeStt();
    expect(stt['opts'].connOptions).toEqual(DEFAULT_API_CONNECT_OPTIONS);
  });

  it('connOptions custom timeout', () => {
    const custom: APIConnectOptions = { timeoutMs: 30000, maxRetry: 3, retryIntervalMs: 2000 };
    const stt = makeStt({ connOptions: custom });
    expect(stt['opts'].connOptions).toEqual(custom);
    expect(stt['opts'].connOptions!.timeoutMs).toBe(30000);
  });

  it('connOptions custom maxRetry', () => {
    const custom: APIConnectOptions = { timeoutMs: 10000, maxRetry: 5, retryIntervalMs: 2000 };
    const stt = makeStt({ connOptions: custom });
    expect(stt['opts'].connOptions).toEqual(custom);
    expect(stt['opts'].connOptions!.maxRetry).toBe(5);
  });

  it('connOptions full custom', () => {
    const custom: APIConnectOptions = { timeoutMs: 60000, maxRetry: 10, retryIntervalMs: 2000 };
    const stt = makeStt({ connOptions: custom });
    expect(stt['opts'].connOptions).toEqual(custom);
    expect(stt['opts'].connOptions!.timeoutMs).toBe(60000);
    expect(stt['opts'].connOptions!.maxRetry).toBe(10);
    expect(stt['opts'].connOptions!.retryIntervalMs).toBe(2000);
  });
});

describe('STT diarization capabilities', () => {
  it('no diarization by default', () => {
    const stt = makeStt();
    expect(stt.capabilities.diarization).toBe(false);
  });

  it('diarization enabled with deepgram diarize option', () => {
    const stt = makeStt({ modelOptions: { diarize: true } });
    expect(stt.capabilities.diarization).toBe(true);
  });

  it('diarization disabled with diarize false', () => {
    const stt = makeStt({ modelOptions: { diarize: false } });
    expect(stt.capabilities.diarization).toBe(false);
  });

  it('diarization enabled with assemblyai speaker_labels', () => {
    const stt = makeStt({
      model: 'assemblyai/universal-streaming',
      modelOptions: { speaker_labels: true },
    });
    expect(stt.capabilities.diarization).toBe(true);
  });

  it('updateOptions toggles diarization capability', () => {
    const stt = makeStt();
    expect(stt.capabilities.diarization).toBe(false);

    stt.updateOptions({ modelOptions: { diarize: true } as Record<string, unknown> });
    expect(stt.capabilities.diarization).toBe(true);

    stt.updateOptions({ modelOptions: { diarize: false } as Record<string, unknown> });
    expect(stt.capabilities.diarization).toBe(false);
  });

  it('diarization enabled with xai diarize option', () => {
    const stt = makeStt({
      model: 'xai/stt-1' satisfies XaiSTTModels,
      modelOptions: { diarize: true },
    });
    expect(stt.capabilities.diarization).toBe(true);
  });

  it('updateOptions preserves unrelated flags when merging', () => {
    const stt = makeStt({ modelOptions: { diarize: true } });
    expect(stt.capabilities.diarization).toBe(true);

    stt.updateOptions({ modelOptions: { endpointing: 500 } as Record<string, unknown> });
    expect(stt['opts'].modelOptions).toHaveProperty('diarize', true);
    expect(stt['opts'].modelOptions).toHaveProperty('endpointing', 500);
    expect(stt.capabilities.diarization).toBe(true);
  });

  it('updateOptions merges modelOptions on associated streams', () => {
    const stt = makeStt({ modelOptions: { diarize: true } });
    const stream = stt.stream();

    stt.updateOptions({ modelOptions: { endpointing: 500 } as Record<string, unknown> });

    // The stream's local modelOptions must be the merged object, not the partial.
    expect(stream['opts'].modelOptions).toHaveProperty('diarize', true);
    expect(stream['opts'].modelOptions).toHaveProperty('endpointing', 500);

    stream.close();
  });
});

describe('STT aligned transcript capability', () => {
  it('agrees with the Cartesia Ink-2 plugin capability', () => {
    const gatewayStt = makeStt({ model: 'cartesia/ink-2' });

    expect(gatewayStt.capabilities.alignedTranscript).toBe(false);
  });

  it('keeps word alignment for models that send words', () => {
    expect(makeStt({ model: 'cartesia/ink-whisper' }).capabilities.alignedTranscript).toBe('word');
    expect(makeStt({ model: 'deepgram/nova-3' }).capabilities.alignedTranscript).toBe('word');
    expect(
      makeStt({ model: 'assemblyai/universal-streaming' }).capabilities.alignedTranscript,
    ).toBe('word');
    expect(makeStt({ model: 'auto' }).capabilities.alignedTranscript).toBe(false);
    expect(makeStt({ model: 'inworld/inworld-stt-1' }).capabilities.alignedTranscript).toBe(false);
  });

  it('recomputes alignment when the model changes', () => {
    const stt = makeStt({ model: 'deepgram/nova-3' });
    expect(stt.capabilities.alignedTranscript).toBe('word');

    stt.updateOptions({ model: 'cartesia/ink-2' });
    expect(stt.capabilities.alignedTranscript).toBe(false);
  });

  it('does not claim alignment for unknown models', () => {
    expect(makeStt({ model: 'new-provider/new-turn-model' }).capabilities.alignedTranscript).toBe(
      false,
    );
  });

  it.each([
    ['cartesia/ink-whisper', 'word'],
    ['cartesia/ink-2', false],
    ['new-provider/new-turn-model', false],
  ] as const)('constrains alignment based on fallback model %s', (fallback, expected) => {
    const stt = makeStt({ model: 'deepgram/nova-3', fallback });

    expect(stt.capabilities.alignedTranscript).toBe(expected);
  });

  it('still accounts for fallback alignment when the primary model changes', () => {
    const stt = makeStt({
      model: 'cartesia/ink-2',
      fallback: 'new-provider/new-turn-model',
    });

    stt.updateOptions({ model: 'deepgram/nova-3' });

    expect(stt.capabilities.alignedTranscript).toBe(false);
  });

  it('surfaces the gateway Ink-2 payload without word alignment', () => {
    const { stream, events } = makeSpeechStream();

    stream['processTranscript'](
      {
        transcript: 'are you open on sunday',
        confidence: 1,
        start: 0,
        duration: 12.5,
        words: [],
        language: 'en',
      },
      SpeechEventType.FINAL_TRANSCRIPT,
    );

    const final = events.find((event) => event.type === SpeechEventType.FINAL_TRANSCRIPT) as {
      alternatives: Array<{ startTime: number; endTime: number; words: unknown[] }>;
    };
    expect(final.alternatives[0]?.words).toEqual([]);
    expect(final.alternatives[0]?.startTime).toBe(0);
    expect(final.alternatives[0]?.endTime).toBe(12.5);
  });
});

describe('STT session keyterms', () => {
  it('updateOptions does not bake session keyterms into the user baseline', () => {
    const stt = makeStt({ model: 'deepgram/nova-3' });
    const stream = stt.stream();

    stt._updateSessionKeyterms(['Niamh']);
    // a later user option update must re-apply session terms to live streams...
    stt.updateOptions({ modelOptions: { endpointing: 500 } as Record<string, unknown> });
    expect(stream['opts'].modelOptions).toHaveProperty('keyterm', ['Niamh']);
    // ...but must not pollute the STT's own user baseline with them
    expect(stt['opts'].modelOptions ?? {}).not.toHaveProperty('keyterm');

    stream.close();
  });

  it('session keyterm change after updateOptions drops stale terms', () => {
    const stt = makeStt({ model: 'deepgram/nova-3' });
    const stream = stt.stream();

    stt._updateSessionKeyterms(['Stale']);
    stt.updateOptions({ modelOptions: { endpointing: 500 } as Record<string, unknown> });

    // detector replaced the session terms: the old one must disappear downstream
    stt._updateSessionKeyterms(['Fresh']);
    expect(stream['opts'].modelOptions).toHaveProperty('keyterm', ['Fresh']);

    stream.close();
  });

  it('user keyterms from modelOptions are preserved across session updates', () => {
    const stt = makeStt({ model: 'deepgram/nova-3', modelOptions: { keyterm: ['Acme'] } });
    const stream = stt.stream();

    stt._updateSessionKeyterms(['Niamh']);
    expect(stream['opts'].modelOptions).toHaveProperty('keyterm', ['Acme', 'Niamh']);

    stt._updateSessionKeyterms(['Other']);
    // user term stays; only the session portion is swapped
    expect(stream['opts'].modelOptions).toHaveProperty('keyterm', ['Acme', 'Other']);

    stream.close();
  });
});

describe('STT VAD handling for Speechmatics models', () => {
  class MockVAD extends VAD {
    label = 'mock';
    constructor() {
      super({ updateInterval: 0 });
    }
    stream(): VADStream {
      throw new Error('not implemented');
    }
  }

  it('non-speechmatics model has no VAD', async () => {
    const stt = makeStt({ model: 'deepgram/nova-3' });
    expect(stt['vad']).toBeUndefined();
    await expect(stt.vadPromise).resolves.toBeUndefined();
  });

  it('speechmatics model with no user vad falls back to the inference VAD', async () => {
    const stt = makeStt({ model: 'speechmatics/enhanced' });
    expect(stt['vad']).toBeInstanceOf(InferenceVAD);
    await expect(stt.vadPromise).resolves.toBe(stt['vad']);
  });

  it('speechmatics model with user vad uses that vad', async () => {
    const vad = new MockVAD();
    const stt = makeStt({ model: 'speechmatics/enhanced', vad });
    expect(stt['vad']).toBe(vad);
    await expect(stt.vadPromise).resolves.toBe(vad);
  });

  it('user vad with non-speechmatics model is ignored', async () => {
    const vad = new MockVAD();
    const stt = makeStt({ model: 'deepgram/nova-3', vad });
    expect(stt['vad']).toBeUndefined();
    await expect(stt.vadPromise).resolves.toBeUndefined();
  });

  it('updateOptions speechmatics → non-speechmatics clears VAD', async () => {
    const vad = new MockVAD();
    const stt = makeStt({ model: 'speechmatics/enhanced', vad });
    await expect(stt.vadPromise).resolves.toBe(vad);

    stt.updateOptions({ model: 'deepgram/nova-3' });
    expect(stt['vad']).toBeUndefined();
    await expect(stt.vadPromise).resolves.toBeUndefined();
  });

  it('updateOptions non-speechmatics → speechmatics falls back to the inference VAD', () => {
    const stt = makeStt({ model: 'deepgram/nova-3' });
    expect(stt['vad']).toBeUndefined();

    stt.updateOptions({ model: 'speechmatics/enhanced' });
    expect(stt['vad']).toBeInstanceOf(InferenceVAD);
  });
});

describeLiveKitInference('LiveKit Inference STT integration', agents, async (harness) => {
  for (const model of [
    'deepgram/nova-3',
    'cartesia/ink-whisper',
    'assemblyai/universal-streaming',
    'xai/stt-1',
  ] as const) {
    describe(model, async () => {
      await harness.stt(new STT({ model }), new InferenceVAD(), {
        nonStreaming: false,
      });
    });
  }
});
