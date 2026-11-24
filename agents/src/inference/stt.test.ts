// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { APIConnectionError, APIStatusError } from '../_exceptions.js';
import * as agents from '../index.js';
import { asLanguageCode, normalizeLanguage } from '../language.js';
import { AgentHandoffItem, ChatMessage } from '../llm/index.js';
import { initializeLogger, log } from '../log.js';
import { createStreamChannel } from '../stream/stream_channel.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { withResolvers } from '../utils.js';
import { VAD, type VADEvent, VADEventType, VADStream } from '../vad.js';
import { createConversationItemAddedEvent } from '../voice/events.js';
import {
  SpeechStream as InferenceSpeechStream,
  STT,
  type STTFallbackModel,
  type STTModels,
  type STTOptions,
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

function makeAssemblyStt(overrides: Record<string, unknown> = {}) {
  return makeStt({ model: 'assemblyai/universal-3-5-pro', ...overrides });
}

function assistantItemEvent(text: string) {
  return createConversationItemAddedEvent(
    ChatMessage.create({ role: 'assistant', content: [text] }),
  );
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
    handoffAudioOffsetInS: 0,
    connectionPadding: [],
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

describe('STT agent_context forwarding', () => {
  it('enables chat context for AssemblyAI U3 Pro family models', () => {
    for (const model of [
      'assemblyai/u3-rt-pro',
      'assemblyai/universal-3-5-pro',
      'assemblyai/universal-3-6-pro',
    ] as const) {
      const stt = makeAssemblyStt({ model });
      expect(stt.capabilities.chatContext).toBe(true);
    }
  });

  it('disables chat context for unsupported AssemblyAI models', () => {
    const stt = makeAssemblyStt({ model: 'assemblyai/universal-streaming' });

    expect(stt.capabilities.chatContext).toBe(false);
  });

  it('disables chat context for non-AssemblyAI models', () => {
    const stt = makeAssemblyStt({ model: 'deepgram/nova-3' });
    expect(stt.capabilities.chatContext).toBe(false);
  });

  it('derives chatContext capability from model support only', () => {
    const stt = makeAssemblyStt({ modelOptions: { previous_context_n_turns: 0 } });
    expect(stt.capabilities.chatContext).toBe(true);
  });

  it('emits active carryover shaping in the session.update wire payload', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const messages: Array<{ type: string }> = [];
    server.on('connection', (socket) => {
      socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    });
    const stt = makeAssemblyStt({ baseURL: `http://127.0.0.1:${port}` });
    const stream = stt.stream();
    try {
      await vi.waitFor(() => expect(messages[0]?.type).toBe('session.create'));
      stt._pushConversationItem(assistantItemEvent('Your room is booked for Tuesday.'));
      await vi.waitFor(() =>
        expect(messages[1]).toMatchObject({
          type: 'session.update',
          settings: { extra: { agent_context: 'Your room is booked for Tuesday.' } },
        }),
      );
      expect(stt['opts'].modelOptions).toHaveProperty(
        'agent_context',
        'Your room is booked for Tuesday.',
      );
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('truncates oversize replies keeping the tail', () => {
    const text = 'a'.repeat(2000) + 'b'.repeat(1750);
    const stt = makeAssemblyStt();
    stt._pushConversationItem(assistantItemEvent(text));
    expect(stt['opts'].modelOptions).toHaveProperty('agent_context', 'b'.repeat(1750));
  });

  it('ignores non-assistant items', () => {
    const stt = makeAssemblyStt();

    stt._pushConversationItem(
      createConversationItemAddedEvent(ChatMessage.create({ role: 'user', content: ['hi there'] })),
    );
    expect(stt['opts'].modelOptions).not.toHaveProperty('agent_context');

    stt._pushConversationItem(
      createConversationItemAddedEvent(ChatMessage.create({ role: 'assistant', content: [] })),
    );
    expect(stt['opts'].modelOptions).not.toHaveProperty('agent_context');
  });

  it('ignores agent handoff items', () => {
    const stt = makeAssemblyStt();
    stt._pushConversationItem(
      createConversationItemAddedEvent(AgentHandoffItem.create({ newAgentId: 'agent-2' })),
    );
    expect(stt['opts'].modelOptions).not.toHaveProperty('agent_context');
  });

  it('preserves explicit agent_context and later overwrites it with carryover', () => {
    const stt = makeAssemblyStt({
      modelOptions: { agent_context: 'The agent asked for a booking date.' },
    });
    expect(stt['opts'].modelOptions).toHaveProperty(
      'agent_context',
      'The agent asked for a booking date.',
    );

    stt._pushConversationItem(assistantItemEvent('And your zip code?'));
    expect(stt['opts'].modelOptions).toHaveProperty('agent_context', 'And your zip code?');
  });

  it('re-evaluates chat context capability on model update', () => {
    const stt = makeAssemblyStt({ model: 'assemblyai/universal-streaming' });
    expect(stt.capabilities.chatContext).toBe(false);

    stt.updateOptions({ model: 'assemblyai/universal-3-5-pro' });
    expect(stt.capabilities.chatContext).toBe(true);
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
    expect(makeStt({ model: 'assemblyai/universal-3-6-pro' }).capabilities.alignedTranscript).toBe(
      'word',
    );
    expect(
      makeStt({ model: 'assemblyai/assemblyai-stt-3-7-realtime-agent' }).capabilities
        .alignedTranscript,
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

  it('AssemblyAI uses an external VAD only when opted in', async () => {
    const vad = new MockVAD();
    const serverEndpointing = makeStt({ model: 'assemblyai/universal-3-6-pro', vad });
    expect(serverEndpointing['vad']).toBeUndefined();
    expect(serverEndpointing.capabilities.manualFlush).not.toBe(true);

    const externalEndpointing = makeStt({
      model: 'assemblyai/universal-3-6-pro',
      vad,
      externalEndpointing: true,
    });
    expect(externalEndpointing['vad']).toBe(vad);
    expect(externalEndpointing.capabilities.manualFlush).not.toBe(true);
  });

  it('AssemblyAI external endpointing uses session turn finalization without a VAD', () => {
    const stt = makeStt({
      model: 'assemblyai/universal-3-6-pro',
      externalEndpointing: true,
    });
    expect(stt.capabilities.manualFlush).toBe(true);
  });

  it('live AssemblyAI stream keeps manual flush after a model switch', () => {
    const stt = makeStt({
      model: 'assemblyai/universal-3-6-pro',
      externalEndpointing: true,
    });
    const live = stt.stream();
    stt.updateOptions({ model: 'deepgram/nova-3' });

    expect(stt.capabilities.manualFlush).not.toBe(true);
    expect(live.manualFlush).toBe(true);
    const next = stt.stream();
    expect(next.manualFlush).toBe(false);

    live.close();
    next.close();
  });

  it('AssemblyAI stream keeps a manual flush opt-out', () => {
    class OptOutSTT extends STT<'assemblyai/universal-3-6-pro'> {
      optOut(): void {
        this.updateCapabilities({ manualFlush: false });
      }
    }

    const stt = new OptOutSTT({
      model: 'assemblyai/universal-3-6-pro',
      externalEndpointing: true,
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      baseURL: 'https://example.livekit.cloud',
    });
    stt.optOut();
    const stream = stt.stream();
    expect(stream.manualFlush).toBe(false);
    stream.close();
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

describe('AssemblyAI external endpointing', () => {
  const noRetry = { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 };

  async function nextFinal(stream: InferenceSpeechStream<STTModels>) {
    for await (const event of stream) {
      if (event.type === SpeechEventType.FINAL_TRANSCRIPT) return event;
    }
    throw new Error('stream ended before a final transcript');
  }

  it.each([
    ['assemblyai/universal-3-6-pro', { min_turn_silence: 10_000, max_turn_silence: 10_000 }],
    ['assemblyai/assemblyai-stt-3-7-realtime-agent', { mode: 'manual' }],
  ] as const)('finalizes %s turns in order while input stays open', async (model, modelOptions) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const wire: Array<{ type: string; settings?: { extra?: Record<string, unknown> } }> = [];
    const samplesSeen: number[] = [];

    class EndOnChunkStream extends VADStream {
      override pushFrame(frame: AudioFrame): void {
        samplesSeen.push(frame.samplesPerChannel);
        super.pushFrame(frame);
        this.sendVADEvent({
          type: VADEventType.END_OF_SPEECH,
          samplesIndex: frame.samplesPerChannel,
          timestamp: 0,
          speechDuration: frame.duration,
          silenceDuration: 0,
          frames: [],
          probability: 0,
          inferenceDuration: 0,
          speaking: false,
          rawAccumulatedSilence: 0,
          rawAccumulatedSpeech: frame.duration,
        });
      }
    }
    class EndOnChunkVAD extends VAD {
      label = 'end-on-chunk';
      constructor() {
        super({ updateInterval: 1 });
      }
      stream(): VADStream {
        return new EndOnChunkStream(this);
      }
    }

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings?: { extra?: Record<string, unknown> };
        };
        wire.push(event);
        if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({
              type: 'final_transcript',
              transcript: 'hello',
              language: 'en',
              start: 0,
              duration: 0.05,
              confidence: 1,
              words: [],
            }),
          );
          socket.send(JSON.stringify({ type: 'session.finalized' }));
        }
      });
    });

    const stt = makeStt({
      model,
      modelOptions,
      vad: new EndOnChunkVAD(),
      externalEndpointing: true,
      sampleRate: 16_000,
      baseURL: `http://127.0.0.1:${port}`,
      connOptions: noRetry,
    });
    const stream = stt.stream();
    try {
      expect(stt.capabilities.manualFlush).not.toBe(true);
      for (let turn = 0; turn < 2; turn++) {
        stream.pushFrame(new AudioFrame(new Int16Array(320), 16_000, 1, 320));
        stream.pushFrame(new AudioFrame(new Int16Array(480), 16_000, 1, 480));
        expect((await nextFinal(stream)).alternatives?.[0]?.text).toBe('hello');
      }
      expect(wire.map(({ type }) => type)).toEqual([
        'session.create',
        'input_audio',
        'session.finalize',
        'input_audio',
        'session.finalize',
      ]);
      expect(samplesSeen).toEqual([800, 800]);
      expect(wire[0]?.settings?.extra).toMatchObject(modelOptions);
      expect(wire[0]?.settings?.extra).not.toHaveProperty('externalEndpointing');
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends short audio before each external flush and pads it to 50 ms', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const wire: Array<{ type: string; audio?: string }> = [];
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string; audio?: string };
        wire.push(event);
        if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({
              type: 'final_transcript',
              transcript: 'hello',
              language: 'en',
              start: 0,
              duration: 0.02,
              confidence: 1,
              words: [],
            }),
          );
          socket.send(JSON.stringify({ type: 'session.finalized' }));
        }
      });
    });
    const stream = makeStt({
      model: 'assemblyai/universal-3-6-pro',
      externalEndpointing: true,
      sampleRate: 16_000,
      baseURL: `http://127.0.0.1:${port}`,
      connOptions: noRetry,
    }).stream();
    const audio = new Int16Array(320).fill(1);
    try {
      stream.pushFrame(new AudioFrame(audio, 16_000, 1, 320));
      stream.flush();
      stream.pushFrame(new AudioFrame(audio, 16_000, 1, 320));
      stream.endInput();
      expect((await nextFinal(stream)).alternatives?.[0]?.text).toBe('hello');
      expect((await nextFinal(stream)).alternatives?.[0]?.text).toBe('hello');
      expect(wire.map(({ type }) => type)).toEqual([
        'session.create',
        'input_audio',
        'session.finalize',
        'input_audio',
        'session.finalize',
      ]);
      const padded = Buffer.alloc(1600);
      Buffer.from(audio.buffer).copy(padded);
      expect(
        wire
          .filter(({ type }) => type === 'input_audio')
          .map(({ audio }) => Buffer.from(audio!, 'base64')),
      ).toEqual([padded, padded]);
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('removes external endpointing padding from transcript timestamps', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    let finalizes = 0;
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        if (event.type !== 'session.finalize') return;
        const start = 0.05 * finalizes++;
        socket.send(
          JSON.stringify({
            type: 'final_transcript',
            transcript: 'hello',
            language: 'en',
            start,
            duration: 0.02,
            confidence: 1,
            words: [{ word: 'hello', start, end: start + 0.03, confidence: 1 }],
          }),
        );
        socket.send(JSON.stringify({ type: 'session.finalized' }));
      });
    });
    const stream = makeStt({
      model: 'assemblyai/universal-3-6-pro',
      externalEndpointing: true,
      sampleRate: 16_000,
      baseURL: `http://127.0.0.1:${port}`,
      connOptions: noRetry,
    }).stream();
    try {
      const timings: number[][] = [];
      for (let turn = 0; turn < 2; turn++) {
        stream.pushFrame(new AudioFrame(new Int16Array(320), 16_000, 1, 320));
        stream.flush();
        const speech = (await nextFinal(stream)).alternatives![0]!;
        const word = speech.words![0]!;
        timings.push(
          [speech.startTime, speech.endTime, word.startTime, word.endTime].map((value) =>
            Number((value - stream.startTimeOffset).toFixed(6)),
          ),
        );
      }
      expect(timings).toEqual([
        [0, 0.02, 0, 0.02],
        [0.02, 0.04, 0.02, 0.04],
      ]);
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Inference STT handoff replay', () => {
  it('keeps the whole replay queue when a write fails partway', () => {
    const { stream } = makeSpeechStream();
    const sent: string[] = [];
    const onSent = vi.fn();
    stream['handoffWrites'] = ['a', 'b', 'c'].map((encoded) => ({ encoded, onSent }));

    const failing = {
      readyState: 1,
      send: (encoded: string) => {
        if (encoded === 'b') throw new Error('closed');
      },
    } as unknown as WebSocket;
    expect(() => stream['releaseHandoffWrites'](failing)).toThrow();
    expect(stream['handoffWrites'].map((w) => w.encoded)).toEqual(['a', 'b', 'c']);
    expect(onSent).not.toHaveBeenCalled();

    const fresh = { readyState: 1, send: (encoded: string) => sent.push(encoded) };
    stream['releaseHandoffWrites'](fresh as unknown as WebSocket);
    expect(sent).toEqual(['a', 'b', 'c']);
    expect(stream['handoffWrites']).toEqual([]);
    expect(onSent).toHaveBeenCalledTimes(3);
  });
});

describe('Inference STT handoff replay', () => {
  it('sends the extra headers on the handoff probe', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const features: (string | string[] | undefined)[] = [];
    let probed!: () => void;
    const probe = new Promise<void>((resolve) => {
      probed = resolve;
    });
    server.on('connection', (socket, request) => {
      const connection = features.push(request.headers['x-feature']);
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        if (event.type === 'session.create') {
          socket.send(JSON.stringify({ type: 'session.created' }));
          if (connection === 2) probed();
        } else if (event.type === 'input_audio' && connection === 1) {
          socket.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'h1' }));
        }
      });
    });
    const stt = makeStt({
      model: 'soniox/stt-rt',
      sampleRate: 16000,
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
    });
    stt.on('error', () => {});
    const stream = stt.stream({ extraHeaders: { 'X-Feature': 'amd' } });
    try {
      stream.pushFrame(new AudioFrame(new Int16Array(800), 16000, 1, 800));
      await Promise.race([
        probe,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('probe timeout')), 2000),
        ),
      ]);
      expect(features).toEqual(['amd', 'amd']);
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Inference STT connection lifecycle', () => {
  it('keeps a VAD finalize after partial audio across handoff', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const vadEvents = createStreamChannel<VADEvent>();
    let partialFrame!: () => void;
    const partial = new Promise<void>((resolve) => {
      partialFrame = resolve;
    });
    let frameCount = 0;
    const vad = new (class extends VAD {
      label = 'handoff-test';
      constructor() {
        super({ updateInterval: 1 });
      }
      stream(): VADStream {
        const reader = vadEvents.stream().getReader();
        return {
          pushFrame() {
            if (++frameCount === 2) partialFrame();
          },
          endInput() {},
          next: () => reader.read(),
          close() {
            void reader.cancel();
            void vadEvents.close().catch(() => {});
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        } as unknown as VADStream;
      }
    })();
    let pause!: () => void;
    const paused = new Promise<void>((resolve) => {
      pause = resolve;
    });
    let candidate: WebSocket | undefined;
    const candidateMessages: string[] = [];
    let connectionCount = 0;
    server.on('connection', (socket) => {
      const index = ++connectionCount;
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        if (event.type === 'session.create') {
          socket.send(JSON.stringify({ type: 'session.created' }));
          if (index === 2) candidate = socket;
        } else if (index === 1 && event.type === 'input_audio') {
          socket.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'h1' }));
        } else if (event.type === 'session.handoff.pause') pause();
        else if (event.type === 'session.handoff.prepared')
          socket.send(JSON.stringify({ type: 'session.handoff.drained', handoff_id: 'h1' }));
        else if (event.type === 'session.handoff.complete')
          socket.send(JSON.stringify({ type: 'session.handoff.accepted', handoff_id: 'h1' }));
        if (index === 2 && event.type !== 'session.create') candidateMessages.push(event.type);
      });
    });
    const stream = makeStt({
      model: 'speechmatics/enhanced',
      vad,
      sampleRate: 16000,
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
    }).stream();
    try {
      stream.pushFrame(new AudioFrame(new Int16Array(800), 16000, 1, 800));
      await paused;
      stream.pushFrame(new AudioFrame(new Int16Array(320), 16000, 1, 320));
      await partial;
      await vadEvents.write({
        type: VADEventType.END_OF_SPEECH,
        samplesIndex: 1120,
        timestamp: 0,
        speechDuration: 70,
        silenceDuration: 0,
        frames: [],
        probability: 0,
        inferenceDuration: 0,
        speaking: false,
        rawAccumulatedSilence: 0,
        rawAccumulatedSpeech: 70,
      });
      await vi.waitFor(() => expect(stream['handoffWrites'].length).toBeGreaterThan(0));
      stream.flush();
      await vi.waitFor(() => expect(candidate).toBeDefined());
      candidate!.send(JSON.stringify({ type: 'session.handoff.ready', handoff_id: 'h1' }));
      await vi.waitFor(() => expect(candidateMessages).toHaveLength(2));
      expect(candidateMessages).toEqual(['input_audio', 'session.finalize']);
    } finally {
      stream.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['soniox/stt-rt', 'speechmatics/enhanced'])(
    'prepares a ready replacement before draining %s',
    async (model) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(server, 'listening');
      const address = server.address() as AddressInfo;
      let connectionCount = 0;
      const audioConnections: number[] = [];
      let pause!: () => void;
      let complete!: () => void;
      let completionSeen = false;
      let replacementCreated!: () => void;
      let replacementAudio!: () => void;
      const paused = new Promise<void>((resolve) => {
        pause = resolve;
      });
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const replacementStarted = new Promise<void>((resolve) => {
        replacementCreated = resolve;
      });
      const received = new Promise<void>((resolve) => {
        replacementAudio = resolve;
      });
      let oldSocket: WebSocket | undefined;
      let newSocket: WebSocket | undefined;
      server.on('connection', (socket) => {
        const connection = ++connectionCount;
        socket.on('message', (raw) => {
          const event = JSON.parse(raw.toString()) as { type: string; handoff_id?: string };
          if (event.type === 'session.create') {
            socket.send(JSON.stringify({ type: 'session.created' }));
            if (connection === 2) {
              newSocket = socket;
              replacementCreated();
            }
          }
          if (event.type === 'input_audio') {
            audioConnections.push(connection);
            if (connection === 1) {
              oldSocket = socket;
              socket.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'h1' }));
            } else {
              socket.send(
                JSON.stringify({
                  type: 'final_transcript',
                  transcript: 'later',
                  language: 'en',
                  start: 0,
                  duration: 0.05,
                }),
              );
              replacementAudio();
            }
          }
          if (event.type === 'session.handoff.pause') pause();
          if (event.type === 'session.handoff.prepared') {
            expect(connection).toBe(1);
            socket.send(JSON.stringify({ type: 'session.handoff.drained', handoff_id: 'h1' }));
          }
          if (event.type === 'session.handoff.complete') {
            completionSeen = true;
            complete();
          }
        });
      });
      const vad = new (class extends VAD {
        label = 'handoff-test';
        streams = 0;
        constructor() {
          super({ updateInterval: 1 });
        }
        stream(): VADStream {
          this.streams++;
          const channel = createStreamChannel<never>();
          const reader = channel.stream().getReader();
          return {
            pushFrame() {},
            endInput() {},
            next: () => reader.read(),
            close() {
              void reader.cancel();
              void channel.close().catch(() => {});
            },
            [Symbol.asyncIterator]() {
              return this;
            },
          } as unknown as VADStream;
        }
      })();
      const stt = makeStt({
        model,
        vad,
        sampleRate: 16000,
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
      });
      const stream = stt.stream();
      const finals: SpeechEvent[] = [];
      const outputTask = (async () => {
        for await (const event of stream) {
          if (event.type === SpeechEventType.FINAL_TRANSCRIPT) finals.push(event);
        }
      })();
      void outputTask.catch(() => {});
      const frame = new AudioFrame(new Int16Array(800), 16000, 1, 800);
      try {
        stream.pushFrame(frame);
        await Promise.race([
          paused,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('pause timeout')), 2000),
          ),
        ]);
        stream.pushFrame(frame);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(audioConnections).toEqual([1]);
        await replacementStarted;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(audioConnections).toEqual([1]);
        expect(completionSeen).toBe(false);
        oldSocket!.send(JSON.stringify({ type: 'final_transcript', transcript: 'before ready' }));
        await vi.waitFor(
          () =>
            expect(finals.map((event) => event.alternatives?.[0]?.text)).toEqual(['before ready']),
          { timeout: 500 },
        );
        newSocket!.send(JSON.stringify({ type: 'session.handoff.ready', handoff_id: 'h1' }));
        await Promise.race([
          completed,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('completion timeout')), 2000),
          ),
        ]);
        expect(audioConnections).toEqual([1]);
        oldSocket!.send(JSON.stringify({ type: 'session.handoff.accepted', handoff_id: 'h1' }));
        await Promise.race([
          received,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('audio timeout')), 2000),
          ),
        ]);
        expect(audioConnections).toEqual([1, 2]);
        if (model.startsWith('speechmatics/')) expect(vad.streams).toBe(1);
        await vi.waitFor(() => expect(finals).toHaveLength(2));
        expect(finals[1]?.alternatives?.[0]?.startTime).toBeCloseTo(0.05, 2);
      } finally {
        stream.close();
        await outputTask;
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('resumes buffered audio if the replacement rejects after creation', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let connections = 0;
    const audioConnections: number[] = [];
    let onPause!: () => void;
    let onResume!: () => void;
    const paused = new Promise<void>((resolve) => {
      onPause = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      onResume = resolve;
    });
    server.on('connection', (socket) => {
      const connection = ++connections;
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string; handoff_id?: string };
        if (event.type === 'session.handoff.prepared')
          socket.send(
            JSON.stringify({ type: 'session.handoff.drained', handoff_id: event.handoff_id }),
          );
      });
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        if (event.type === 'session.create') {
          socket.send(JSON.stringify({ type: 'session.created' }));
          if (connection === 2) socket.send(JSON.stringify({ type: 'error', code: 429 }));
        } else if (event.type === 'input_audio') {
          audioConnections.push(connection);
          if (audioConnections.length === 1) {
            socket.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'h1' }));
          } else onResume();
        } else if (event.type === 'session.handoff.pause') onPause();
      });
    });
    const stt = makeStt({
      model: 'soniox/stt-rt',
      sampleRate: 16000,
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
    });
    const stream = stt.stream();
    const frame = new AudioFrame(new Int16Array(800), 16000, 1, 800);
    try {
      stream.pushFrame(frame);
      await Promise.race([
        paused,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('pause timeout')), 2000),
        ),
      ]);
      stream.pushFrame(frame);
      await Promise.race([
        resumed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('resume timeout')), 2000),
        ),
      ]);
      expect(audioConnections).toEqual([1, 1]);
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('aborts when a ready replacement reports an error before acceptance', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let connections = 0;
    const audioConnections: number[] = [];
    let pausedResolve!: () => void;
    let resumedResolve!: () => void;
    const paused = new Promise<void>((resolve) => {
      pausedResolve = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resumedResolve = resolve;
    });
    let replacement: WebSocket | undefined;
    server.on('connection', (socket) => {
      const connection = ++connections;
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string; handoff_id?: string };
        if (event.type === 'session.handoff.prepared')
          socket.send(
            JSON.stringify({ type: 'session.handoff.drained', handoff_id: event.handoff_id }),
          );
      });
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        if (event.type === 'session.create') {
          socket.send(JSON.stringify({ type: 'session.created' }));
          if (connection === 2) {
            replacement = socket;
            socket.send(JSON.stringify({ type: 'session.handoff.ready', handoff_id: 'h1' }));
          }
        } else if (event.type === 'input_audio') {
          audioConnections.push(connection);
          if (audioConnections.length === 1) {
            socket.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'h1' }));
          } else resumedResolve();
        } else if (event.type === 'session.handoff.pause') pausedResolve();
        else if (event.type === 'session.handoff.complete')
          replacement!.send(JSON.stringify({ type: 'error', code: 429 }));
      });
    });
    const stt = makeStt({
      model: 'soniox/stt-rt',
      sampleRate: 16000,
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
    });
    const stream = stt.stream();
    const frame = new AudioFrame(new Int16Array(800), 16000, 1, 800);
    try {
      stream.pushFrame(frame);
      await Promise.race([
        paused,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('pause timeout')), 2000),
        ),
      ]);
      stream.pushFrame(frame);
      await Promise.race([
        resumed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('resume timeout')), 2000),
        ),
      ]);
      expect(audioConnections).toEqual([1, 1]);
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('aborts when an error arrives in the same batch as readiness', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let connections = 0;
    let completeSeen = false;
    const audioConnections: number[] = [];
    let pausedResolve!: () => void;
    let resumedResolve!: () => void;
    const paused = new Promise<void>((resolve) => {
      pausedResolve = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resumedResolve = resolve;
    });
    server.on('connection', (socket) => {
      const connection = ++connections;
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string; handoff_id?: string };
        if (event.type === 'session.create') {
          if (connection === 2) {
            // corked so all three frames reach the client in one read
            const tcp = (socket as unknown as { _socket: { cork(): void; uncork(): void } })
              ._socket;
            tcp.cork();
            socket.send(JSON.stringify({ type: 'session.created' }));
            socket.send(JSON.stringify({ type: 'session.handoff.ready', handoff_id: 'h1' }));
            socket.send(JSON.stringify({ type: 'error', code: 429 }));
            process.nextTick(() => tcp.uncork());
          } else socket.send(JSON.stringify({ type: 'session.created' }));
        } else if (event.type === 'input_audio') {
          audioConnections.push(connection);
          if (audioConnections.length === 1) {
            socket.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'h1' }));
          } else resumedResolve();
        } else if (event.type === 'session.handoff.pause') pausedResolve();
        else if (event.type === 'session.handoff.prepared')
          socket.send(JSON.stringify({ type: 'session.handoff.drained', handoff_id: 'h1' }));
        else if (event.type === 'session.handoff.complete') {
          completeSeen = true;
          socket.send(JSON.stringify({ type: 'session.handoff.accepted', handoff_id: 'h1' }));
        }
      });
    });
    const stt = makeStt({
      model: 'soniox/stt-rt',
      sampleRate: 16000,
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
    });
    const stream = stt.stream();
    const frame = new AudioFrame(new Int16Array(800), 16000, 1, 800);
    try {
      stream.pushFrame(frame);
      await Promise.race([
        paused,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('pause timeout')), 2000),
        ),
      ]);
      stream.pushFrame(frame);
      await Promise.race([
        resumed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('resume timeout')), 2000),
        ),
      ]);
      expect(audioConnections).toEqual([1, 1]);
      expect(completeSeen).toBe(false);
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('ignores messages from the retired socket after a handoff', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let connections = 0;
    let pause!: () => void;
    let replay!: () => void;
    const paused = new Promise<void>((resolve) => {
      pause = resolve;
    });
    const replayed = new Promise<void>((resolve) => {
      replay = resolve;
    });
    server.on('connection', (socket) => {
      const connection = ++connections;
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        if (event.type === 'session.create') {
          socket.send(JSON.stringify({ type: 'session.created' }));
          if (connection === 2)
            socket.send(JSON.stringify({ type: 'session.handoff.ready', handoff_id: 'h1' }));
        } else if (event.type === 'input_audio' && connection === 1) {
          socket.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'h1' }));
        } else if (event.type === 'input_audio' && connection === 2) {
          replay();
          socket.send(JSON.stringify({ ...transcript('later', true), duration: 0.05 }));
        } else if (event.type === 'session.handoff.pause') pause();
        else if (event.type === 'session.handoff.prepared')
          socket.send(JSON.stringify({ type: 'session.handoff.drained', handoff_id: 'h1' }));
        else if (event.type === 'session.handoff.complete') {
          socket.send(JSON.stringify({ type: 'session.handoff.accepted', handoff_id: 'h1' }));
          socket.send(JSON.stringify({ type: 'session.closed' }));
        } else if (event.type === 'session.handoff.switched') {
          socket.send(JSON.stringify({ type: 'error', code: 500, message: 'retired' }));
        }
      });
    });
    const stt = makeStt({
      model: 'soniox/stt-rt',
      sampleRate: 16000,
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
    });
    const errors: unknown[] = [];
    stt.on('error', (error) => errors.push(error));
    const stream = stt.stream();
    const result = (async () => {
      for await (const event of stream) {
        if (event.type === SpeechEventType.FINAL_TRANSCRIPT) return event;
      }
      throw new Error('stream ended without a final transcript');
    })();
    void result.catch(() => {});
    const frame = new AudioFrame(new Int16Array(800), 16000, 1, 800);
    try {
      stream.pushFrame(frame);
      await paused;
      stream.pushFrame(frame);
      await Promise.race([
        replayed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('replay timeout')), 2000),
        ),
      ]);
      const final = await result;
      expect(final.alternatives?.[0]?.text).toBe('later');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(errors).toEqual([]);
      expect(connections).toBe(2);
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([800, 400])(
    'replays %i samples after the old socket fails during a pause',
    async (samples) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(server, 'listening');
      const address = server.address() as AddressInfo;
      let connections = 0;
      let oldSocket: WebSocket | undefined;
      let pausedResolve!: () => void;
      let replayedResolve!: () => void;
      const paused = new Promise<void>((resolve) => {
        pausedResolve = resolve;
      });
      const replayed = new Promise<void>((resolve) => {
        replayedResolve = resolve;
      });
      const audioConnections: number[] = [];
      server.on('connection', (socket) => {
        const connection = ++connections;
        socket.on('message', (raw) => {
          const event = JSON.parse(raw.toString()) as { type: string; handoff_id?: string };
          if (event.type === 'session.handoff.prepared')
            socket.send(
              JSON.stringify({ type: 'session.handoff.drained', handoff_id: event.handoff_id }),
            );
        });
        socket.on('message', (raw) => {
          const event = JSON.parse(raw.toString()) as { type: string };
          if (event.type === 'session.create')
            socket.send(JSON.stringify({ type: 'session.created' }));
          if (event.type === 'input_audio') {
            audioConnections.push(connection);
            if (connection === 1) {
              oldSocket = socket;
              socket.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'h1' }));
            } else replayedResolve();
          }
          if (event.type === 'session.handoff.pause') pausedResolve();
        });
      });
      const stt = makeStt({
        model: 'soniox/stt-rt',
        sampleRate: 16000,
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 },
      });
      stt.on('error', () => {});
      const stream = stt.stream();
      const frame = new AudioFrame(new Int16Array(800), 16000, 1, 800);
      try {
        stream.pushFrame(frame);
        await Promise.race([
          paused,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('pause timeout')), 2000),
          ),
        ]);
        stream.pushFrame(new AudioFrame(new Int16Array(samples), 16000, 1, samples));
        await new Promise((resolve) => setTimeout(resolve, 50));
        oldSocket!.terminate();
        await Promise.race([
          replayed,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('replay timeout')), 2000),
          ),
        ]);
        expect(audioConnections).toEqual([1, 3]);
      } finally {
        stream.close();
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('retries retained audio when replay to the replacement throws', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const originalSend = WebSocket.prototype.send;
    const candidates = new WeakSet<WebSocket>();
    let failed = false;
    const sendSpy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket['send']>
    ) {
      const data = args[0];
      if (typeof data === 'string') {
        const event = JSON.parse(data) as { type?: string; handoff_probe?: unknown };
        if (event.type === 'session.create' && event.handoff_probe) candidates.add(this);
        if (event.type === 'input_audio' && candidates.has(this) && !failed) {
          failed = true;
          throw new Error('simulated replacement write failure');
        }
      }
      return originalSend.apply(this, args);
    });
    let connections = 0;
    let oldSocket: WebSocket | undefined;
    let pause!: () => void;
    let complete!: () => void;
    let replay!: () => void;
    const paused = new Promise<void>((resolve) => {
      pause = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const replayed = new Promise<void>((resolve) => {
      replay = resolve;
    });
    const audioConnections: number[] = [];
    server.on('connection', (socket) => {
      const connection = ++connections;
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string; handoff_id?: string };
        if (event.type === 'session.handoff.prepared')
          socket.send(
            JSON.stringify({ type: 'session.handoff.drained', handoff_id: event.handoff_id }),
          );
      });
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        if (event.type === 'session.create') {
          socket.send(JSON.stringify({ type: 'session.created' }));
          if (connection === 2)
            socket.send(JSON.stringify({ type: 'session.handoff.ready', handoff_id: 'h1' }));
        } else if (event.type === 'input_audio') {
          audioConnections.push(connection);
          if (connection === 1) {
            oldSocket = socket;
            socket.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'h1' }));
          } else if (connection === 3) replay();
        } else if (event.type === 'session.handoff.pause') pause();
        else if (event.type === 'session.handoff.complete') complete();
      });
    });
    const stt = makeStt({
      model: 'soniox/stt-rt',
      sampleRate: 16000,
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 },
    });
    stt.on('error', () => {});
    const stream = stt.stream();
    const frame = new AudioFrame(new Int16Array(800), 16000, 1, 800);
    try {
      stream.pushFrame(frame);
      await paused;
      stream.pushFrame(frame);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await completed;
      oldSocket!.send(JSON.stringify({ type: 'session.handoff.accepted', handoff_id: 'h1' }));
      await Promise.race([
        replayed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('replay timeout')), 2000),
        ),
      ]);
      expect(failed).toBe(true);
      expect(audioConnections).toEqual([1, 3]);
    } finally {
      stream.close();
      sendSpy.mockRestore();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('flushes partial audio before an update queued before the first dial', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const wire: { type: string; settings?: { language?: string } }[] = [];
    server.on('connection', (socket) => {
      socket.on('message', (raw) => wire.push(JSON.parse(raw.toString())));
    });
    const stt = makeStt({
      model: 'soniox/stt-rt',
      language: 'en',
      baseURL: `http://127.0.0.1:${port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
    });
    const stream = stt.stream();
    try {
      stream.pushFrame(new AudioFrame(new Int16Array(320), 16000, 1, 320));
      stream.updateOptions({ language: 'fr' });
      stream.flush();
      await vi.waitFor(() =>
        expect(wire).toMatchObject([
          { type: 'session.create', settings: { language: 'en' } },
          { type: 'input_audio' },
          { type: 'session.update', settings: { language: 'fr' } },
        ]),
      );
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('waits for a preceding update acknowledgement before pausing the old socket', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const wire: { socket: WebSocket; event: { type: string; settings?: { language?: string } } }[] =
      [];
    server.on('connection', (socket) => {
      socket.on('message', (raw) => wire.push({ socket, event: JSON.parse(raw.toString()) }));
    });
    const stt = makeStt({
      model: 'soniox/stt-rt',
      language: 'en',
      baseURL: `http://127.0.0.1:${port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
    });
    const stream = stt.stream();
    try {
      await vi.waitFor(() => expect(wire[0]?.event.type).toBe('session.create'));
      const old = wire[0]!.socket;
      stream.updateOptions({
        model: 'cartesia/ink-whisper',
        language: 'fr',
        modelOptions: { prompt: 'Only for Cartesia' },
      });
      await vi.waitFor(() =>
        expect(wire[1]?.event).toMatchObject({
          type: 'session.update',
          settings: { model: 'cartesia/ink-whisper', language: 'fr' },
        }),
      );
      expect(wire[1]?.event.settings).not.toHaveProperty('extra');
      old.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'h1' }));
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(wire.map(({ event }) => event.type)).toEqual(['session.create', 'session.update']);
      old.send(JSON.stringify({ type: 'session.updated', success: true }));
      await vi.waitFor(() => expect(wire[2]?.event.type).toBe('session.handoff.pause'));
      await vi.waitFor(() =>
        expect(wire.find(({ socket }) => socket !== old)?.event).toMatchObject({
          type: 'session.create',
          model: 'soniox/stt-rt',
          settings: { language: 'fr' },
        }),
      );
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps audio and later updates ordered across a handoff', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const events: { connection: number; type: string; language?: string }[] = [];
    let count = 0;
    let pause!: () => void;
    let done!: () => void;
    const paused = new Promise<void>((resolve) => {
      pause = resolve;
    });
    const delivered = new Promise<void>((resolve) => {
      done = resolve;
    });
    server.on('connection', (socket) => {
      const connection = ++count;
      socket.on('message', (raw) => {
        const e = JSON.parse(raw.toString()) as { type: string; settings?: { language?: string } };
        if (
          ['session.create', 'input_audio', 'session.update', 'session.finalize'].includes(e.type)
        )
          events.push({ connection, type: e.type, language: e.settings?.language });
        if (e.type === 'session.create') {
          socket.send(JSON.stringify({ type: 'session.created' }));
          if (connection === 2)
            socket.send(JSON.stringify({ type: 'session.handoff.ready', handoff_id: 'h1' }));
        } else if (e.type === 'input_audio' && connection === 1) {
          socket.send(JSON.stringify({ type: 'session.handoff.request', handoff_id: 'h1' }));
        } else if (e.type === 'session.finalize' && connection === 2) {
          socket.send(JSON.stringify(transcript('done', true)));
          socket.send(JSON.stringify({ type: 'session.closed' }));
          done();
        } else if (e.type === 'session.handoff.pause') pause();
        else if (e.type === 'session.handoff.prepared')
          socket.send(JSON.stringify({ type: 'session.handoff.drained', handoff_id: 'h1' }));
        else if (e.type === 'session.update')
          socket.send(JSON.stringify({ type: 'session.updated', success: true }));
        else if (e.type === 'session.handoff.complete')
          socket.send(JSON.stringify({ type: 'session.handoff.accepted', handoff_id: 'h1' }));
      });
    });
    const stt = makeStt({
      model: 'soniox/stt-rt',
      language: 'en',
      sampleRate: 16000,
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
    });
    const stream = stt.stream();
    const frame = new AudioFrame(new Int16Array(800), 16000, 1, 800);
    try {
      stream.pushFrame(frame);
      await Promise.race([
        paused,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('pause timeout')), 2000),
        ),
      ]);
      stream.pushFrame(new AudioFrame(new Int16Array(320), 16000, 1, 320));
      stream.updateOptions({ language: 'fr' });
      stream.pushFrame(frame);
      stream.endInput();
      await Promise.race([
        delivered,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('delivery timeout')), 2000),
        ),
      ]);
      expect(
        events
          .filter((event) => event.connection === 2)
          .map(({ type, language }) => [type, language]),
      ).toEqual([
        ['session.create', 'en'],
        ['input_audio', undefined],
        ['session.update', 'fr'],
        ['input_audio', undefined],
        ['session.finalize', undefined],
      ]);
      expect(events.filter(({ type }) => type === 'session.finalize')).toHaveLength(1);
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('sends session keyterms to speechmatics/linden-1', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let extra: Record<string, unknown> = {};

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings?: { extra?: Record<string, unknown> };
        };
        if (event.type === 'session.create') {
          extra = event.settings?.extra ?? {};
        } else if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({ type: 'final_transcript', transcript: 'hi', language: 'en' }),
          );
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    try {
      const userEntry = { content: 'gnocchi', sounds_like: ['nyohki'] };
      const stt = makeStt({
        model: 'speechmatics/linden-1',
        modelOptions: { additional_vocab: [userEntry] },
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      expect(stt.capabilities.keyterms).toBe(true);
      stt._updateSessionKeyterms(['gnocchi', 'LiveKit']);
      const stream = stt.stream();

      try {
        stream.endInput();
        for await (const _ of stream) {
          /* drain */
        }
      } finally {
        stream.close();
      }

      expect(extra.additional_vocab).toEqual([userEntry, { content: 'LiveKit' }]);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('drops the Deepgram Nova-3 language hint when the language is not multi', async () => {
    const warn = vi.spyOn(log(), 'warn');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let settings: { language?: string; extra?: Record<string, unknown> } = {};

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings?: { language?: string; extra?: Record<string, unknown> };
        };
        if (event.type === 'session.create') {
          settings = event.settings ?? {};
        } else if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({ type: 'final_transcript', transcript: 'hi', language: 'en' }),
          );
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    try {
      const stt = makeStt({
        model: 'deepgram/nova-3',
        language: 'en',
        modelOptions: { language_hint: ['en', 'es'] } satisfies STTOptions<'deepgram/nova-3'>,
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      const stream = stt.stream();

      try {
        stream.endInput();
        for await (const _ of stream) {
          /* drain */
        }
      } finally {
        stream.close();
      }

      expect(settings.extra).not.toHaveProperty('language_hint');
      expect(warn).toHaveBeenCalledWith(
        'Ignoring `language_hint` for deepgram/nova-3: it only applies with language "multi" (session language "en")',
      );
      // the drop is per session, not a rewrite of what the caller configured
      expect(stt['opts'].modelOptions).toHaveProperty('language_hint', ['en', 'es']);
    } finally {
      warn.mockRestore();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends the Deepgram Nova-3 language hint alongside multi language', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let settings: { language?: string; extra?: Record<string, unknown> } = {};

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings?: { language?: string; extra?: Record<string, unknown> };
        };
        if (event.type === 'session.create') {
          settings = event.settings ?? {};
        } else if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({ type: 'final_transcript', transcript: 'hi', language: 'en' }),
          );
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    try {
      const stt = makeStt({
        model: 'deepgram/nova-3',
        language: 'multi',
        modelOptions: { language_hint: ['en', 'es'] } satisfies STTOptions<'deepgram/nova-3'>,
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      const stream = stt.stream();

      try {
        stream.endInput();
        for await (const _ of stream) {
          /* drain */
        }
      } finally {
        stream.close();
      }

      expect(settings.language).toBe('multi');
      expect(settings.extra).toMatchObject({ language_hint: ['en', 'es'] });
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps the language hint for Deepgram Flux under a non-multi language', async () => {
    const warn = vi.spyOn(log(), 'warn');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let settings: { language?: string; extra?: Record<string, unknown> } = {};

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings?: { language?: string; extra?: Record<string, unknown> };
        };
        if (event.type === 'session.create') {
          settings = event.settings ?? {};
        } else if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({ type: 'final_transcript', transcript: 'hi', language: 'en' }),
          );
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    try {
      const stt = makeStt({
        model: 'deepgram/flux-general-multi',
        language: 'en',
        modelOptions: {
          language_hint: ['en', 'es'],
        } satisfies STTOptions<'deepgram/flux-general-multi'>,
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      const stream = stt.stream();

      try {
        stream.endInput();
        for await (const _ of stream) {
          /* drain */
        }
      } finally {
        stream.close();
      }

      expect(settings.extra).toMatchObject({ language_hint: ['en', 'es'] });
      const hintWarnings = warn.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('language_hint'),
      );
      expect(hintWarnings).toEqual([]);
    } finally {
      warn.mockRestore();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // The key is the caller's for a provider that never asked for it: only Deepgram's models have
  // language rules that make it ours to withhold.
  it('leaves a non-Deepgram model its language_hint', async () => {
    const warn = vi.spyOn(log(), 'warn');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const created: Array<{ extra?: Record<string, unknown> }> = [];
    const updates: Array<{ extra?: Record<string, unknown> }> = [];
    let resolveSessionCreated!: () => void;
    const sessionCreated = new Promise<void>((resolve) => {
      resolveSessionCreated = resolve;
    });

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings?: { extra?: Record<string, unknown> };
        };
        if (event.type === 'session.create') {
          created.push(event.settings ?? {});
          resolveSessionCreated();
        }
        if (event.type === 'session.update') updates.push(event.settings ?? {});
        if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({ type: 'final_transcript', transcript: 'hi', language: 'en' }),
          );
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    try {
      const stt = makeStt({
        model: 'assemblyai/universal-streaming',
        language: 'en',
        modelOptions: { language_hint: ['en', 'es'] },
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      const stream = stt.stream();

      try {
        await sessionCreated;
        expect(created[0]?.extra).toMatchObject({ language_hint: ['en', 'es'] });

        await new Promise<void>((resolve) => setImmediate(resolve));
        stream.updateOptions({
          modelOptions: { language_hint: ['en', 'es'] },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        stream.endInput();
        for await (const _ of stream) {
          /* drain */
        }
      } finally {
        stream.close();
      }

      expect(updates).toHaveLength(1);
      expect(updates[0]?.extra).toMatchObject({ language_hint: ['en', 'es'] });
      const hintWarnings = warn.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('language_hint'),
      );
      expect(hintWarnings).toEqual([]);
    } finally {
      warn.mockRestore();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('drops the hint and warns once across a reconnect', async () => {
    const warn = vi.spyOn(log(), 'warn');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const frames: Array<Record<string, unknown>> = [];
    let connectionCount = 0;
    let resolveSecondConnection!: () => void;
    const secondConnection = new Promise<void>((resolve) => {
      resolveSecondConnection = resolve;
    });

    server.on('connection', (socket) => {
      connectionCount += 1;
      const connection = connectionCount;
      if (connection === 2) resolveSecondConnection();
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings?: { extra?: Record<string, unknown> };
        };
        if (event.type === 'session.create') {
          frames.push(event.settings?.extra ?? {});
          if (connection === 1) {
            socket.send(JSON.stringify({ type: 'session.closed' }), () => socket.close());
          }
        }
        if (connection === 2 && event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({ type: 'final_transcript', transcript: 'final words', language: 'en' }),
          );
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    try {
      const stt = makeStt({
        model: 'deepgram/nova-3',
        language: 'en',
        modelOptions: { language_hint: ['en', 'es'] } satisfies STTOptions<'deepgram/nova-3'>,
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      const stream = stt.stream();

      try {
        await secondConnection;
        stream.endInput();
        for await (const _ of stream) {
          /* drain */
        }
      } finally {
        stream.close();
      }

      expect(connectionCount).toBe(2);
      expect(frames).toHaveLength(2);
      for (const extra of frames) {
        expect(extra).not.toHaveProperty('language_hint');
      }
      // `log()` is a shared singleton, so the spy also sees the framework's own retry warning
      const hintWarnings = warn.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('language_hint'),
      );
      expect(hintWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('drops a language hint added mid-session while the language is not multi', async () => {
    const warn = vi.spyOn(log(), 'warn');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const updates: Array<Record<string, unknown>> = [];
    let resolveSessionCreated!: () => void;
    const sessionCreated = new Promise<void>((resolve) => {
      resolveSessionCreated = resolve;
    });

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings?: { extra?: Record<string, unknown> };
        };
        if (event.type === 'session.create') resolveSessionCreated();
        if (event.type === 'session.update') updates.push(event.settings?.extra ?? {});
        if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({ type: 'final_transcript', transcript: 'hi', language: 'en' }),
          );
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    try {
      const stt = makeStt({
        model: 'deepgram/nova-3',
        language: 'en',
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      const stream = stt.stream();

      try {
        await sessionCreated;
        // let run() install the socket before updating it
        await new Promise<void>((resolve) => setImmediate(resolve));
        stream.updateOptions({
          modelOptions: { language_hint: ['en', 'es'] } satisfies STTOptions<'deepgram/nova-3'>,
        });
        stream.endInput();
        for await (const _ of stream) {
          /* drain */
        }
      } finally {
        stream.close();
      }

      expect(updates).toHaveLength(1);
      expect(updates[0]).not.toHaveProperty('language_hint');
      // the drop applies to the frame, not to what the caller configured
      expect(stream['opts'].modelOptions).toHaveProperty('language_hint', ['en', 'es']);
      const hintWarnings = warn.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('language_hint'),
      );
      expect(hintWarnings).toHaveLength(1);
      expect(hintWarnings[0]?.[0]).toBe(
        'Ignoring `language_hint` for deepgram/nova-3: it only applies with language "multi" (session language "en")',
      );
    } finally {
      warn.mockRestore();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not warn again when a later update repeats an already dropped hint', async () => {
    const warn = vi.spyOn(log(), 'warn');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const updates: Array<Record<string, unknown>> = [];
    let resolveSessionCreated!: () => void;
    const sessionCreated = new Promise<void>((resolve) => {
      resolveSessionCreated = resolve;
    });

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings?: { extra?: Record<string, unknown> };
        };
        if (event.type === 'session.create') resolveSessionCreated();
        if (event.type === 'session.update') updates.push(event.settings?.extra ?? {});
        if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({ type: 'final_transcript', transcript: 'hi', language: 'en' }),
          );
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    try {
      const stt = makeStt({
        model: 'deepgram/nova-3',
        language: 'en',
        modelOptions: { language_hint: ['en', 'es'] } satisfies STTOptions<'deepgram/nova-3'>,
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      const stream = stt.stream();

      try {
        await sessionCreated;
        await new Promise<void>((resolve) => setImmediate(resolve));
        stream.updateOptions({
          modelOptions: { language_hint: ['en', 'es'] } satisfies STTOptions<'deepgram/nova-3'>,
        });
        stream.endInput();
        for await (const _ of stream) {
          /* drain */
        }
      } finally {
        stream.close();
      }

      expect(updates).toHaveLength(1);
      expect(updates[0]).not.toHaveProperty('language_hint');
      const hintWarnings = warn.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('language_hint'),
      );
      // the connect-time drop already spoke for this session
      expect(hintWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps a mid-session hint when the same update switches to multi language', async () => {
    const warn = vi.spyOn(log(), 'warn');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const updates: Array<{ language?: string; extra?: Record<string, unknown> }> = [];
    let resolveSessionCreated!: () => void;
    const sessionCreated = new Promise<void>((resolve) => {
      resolveSessionCreated = resolve;
    });

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings?: { language?: string; extra?: Record<string, unknown> };
        };
        if (event.type === 'session.create') resolveSessionCreated();
        if (event.type === 'session.update') updates.push(event.settings ?? {});
        if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({ type: 'final_transcript', transcript: 'hi', language: 'en' }),
          );
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    try {
      const stt = makeStt({
        model: 'deepgram/nova-3',
        language: 'en',
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      const stream = stt.stream();

      try {
        await sessionCreated;
        await new Promise<void>((resolve) => setImmediate(resolve));
        stream.updateOptions({
          language: asLanguageCode('multi'),
          modelOptions: { language_hint: ['en', 'es'] } satisfies STTOptions<'deepgram/nova-3'>,
        });
        stream.endInput();
        for await (const _ of stream) {
          /* drain */
        }
      } finally {
        stream.close();
      }

      expect(updates).toHaveLength(1);
      expect(updates[0]?.language).toBe('multi');
      expect(updates[0]?.extra).toMatchObject({ language_hint: ['en', 'es'] });
      const hintWarnings = warn.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('language_hint'),
      );
      expect(hintWarnings).toEqual([]);
    } finally {
      warn.mockRestore();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // The hint is the caller's configuration, not a one-shot: a session that starts on a language
  // that cannot use it has to send it once the language can, without a new `modelOptions`.
  it('sends the hint again when the effective language returns to multi', async () => {
    const warn = vi.spyOn(log(), 'warn');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const created: Array<{ extra?: Record<string, unknown> }> = [];
    const updates: Array<{ language?: string; extra?: Record<string, unknown> }> = [];
    let resolveSessionCreated!: () => void;
    const sessionCreated = new Promise<void>((resolve) => {
      resolveSessionCreated = resolve;
    });

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings?: { language?: string; extra?: Record<string, unknown> };
        };
        if (event.type === 'session.create') {
          created.push(event.settings ?? {});
          resolveSessionCreated();
        }
        if (event.type === 'session.update') updates.push(event.settings ?? {});
        if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({ type: 'final_transcript', transcript: 'hi', language: 'en' }),
          );
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    try {
      const modelOptions = { language_hint: ['en', 'es'] } satisfies STTOptions<'deepgram/nova-3'>;
      const stt = makeStt({
        model: 'deepgram/nova-3',
        language: 'en',
        modelOptions,
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      const stream = stt.stream();

      try {
        await sessionCreated;
        expect(created[0]?.extra).not.toHaveProperty('language_hint');

        await new Promise<void>((resolve) => setImmediate(resolve));
        stream.updateOptions({ language: asLanguageCode('multi') });
        await new Promise<void>((resolve) => setImmediate(resolve));
        stream.endInput();
        for await (const _ of stream) {
          /* drain */
        }
      } finally {
        stream.close();
      }

      expect(updates).toHaveLength(1);
      expect(updates[0]?.language).toBe('multi');
      expect(updates[0]?.extra).toMatchObject({ language_hint: ['en', 'es'] });
      // the gate is on the frames, never on what the caller configured
      expect(modelOptions.language_hint).toEqual(['en', 'es']);
      expect(stt['opts'].modelOptions).toBe(modelOptions);
      const hintWarnings = warn.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('language_hint'),
      );
      expect(hintWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // A `modelOptions` update carries the caller's keys alone, so a configured hint that no earlier
  // frame could send has to be added to this one — and only that key, since the rest of the
  // merged options are not what the caller asked to change.
  it('adds the configured hint to a modelOptions update that can now carry it', async () => {
    const warn = vi.spyOn(log(), 'warn');
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const created: Array<{ language?: string; extra?: Record<string, unknown> }> = [];
    const updates: Array<{ language?: string; extra?: Record<string, unknown> }> = [];
    let resolveSessionCreated!: () => void;
    const sessionCreated = new Promise<void>((resolve) => {
      resolveSessionCreated = resolve;
    });

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings?: { language?: string; extra?: Record<string, unknown> };
        };
        if (event.type === 'session.create') {
          created.push(event.settings ?? {});
          resolveSessionCreated();
        }
        if (event.type === 'session.update') updates.push(event.settings ?? {});
        if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({ type: 'final_transcript', transcript: 'hi', language: 'en' }),
          );
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    try {
      const stt = makeStt({
        model: 'deepgram/nova-3',
        language: 'en',
        modelOptions: {
          language_hint: ['en', 'es'],
          endpointing: 500,
        } satisfies STTOptions<'deepgram/nova-3'>,
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      const stream = stt.stream();

      try {
        await sessionCreated;
        expect(created[0]?.extra).not.toHaveProperty('language_hint');

        await new Promise<void>((resolve) => setImmediate(resolve));
        stream.updateOptions({
          language: asLanguageCode('multi'),
          modelOptions: { keyterm: ['LiveKit'] } satisfies STTOptions<'deepgram/nova-3'>,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        stream.endInput();
        for await (const _ of stream) {
          /* drain */
        }
      } finally {
        stream.close();
      }

      expect(updates).toHaveLength(1);
      expect(updates[0]?.language).toBe('multi');
      expect(updates[0]?.extra).toMatchObject({
        keyterm: ['LiveKit'],
        language_hint: ['en', 'es'],
      });
      expect(Object.keys(updates[0]?.extra ?? {}).sort()).toEqual(['keyterm', 'language_hint']);
      const hintWarnings = warn.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('language_hint'),
      );
      // the connect-time drop already spoke for this session
      expect(hintWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps receiving transcripts after session.finalized', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const messageTypes: string[] = [];
    const transcripts: string[] = [];
    let closeBeforeTranscript = false;
    let transcriptSent = false;
    let requestUrl: string | undefined;
    let resolveSessionCreated!: () => void;
    const sessionCreated = new Promise<void>((resolve) => {
      resolveSessionCreated = resolve;
    });
    let resolveFinalizeReceived!: () => void;
    const finalizeReceived = new Promise<void>((resolve) => {
      resolveFinalizeReceived = resolve;
    });
    let resolveSocketClosed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      resolveSocketClosed = resolve;
    });

    server.on('connection', (socket, request) => {
      requestUrl = request.url;
      socket.on('close', resolveSocketClosed);
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        messageTypes.push(event.type);
        if (event.type === 'session.create') resolveSessionCreated();
        if (event.type === 'session.finalize') {
          resolveFinalizeReceived();
          socket.send(JSON.stringify({ type: 'session.finalized' }));
          setTimeout(() => {
            if (socket.readyState !== 1) return;
            socket.send(
              JSON.stringify({
                type: 'final_transcript',
                transcript: 'final words',
                language: 'en',
              }),
            );
            transcriptSent = true;
          }, 25);
        }
        if (event.type === 'session.close') {
          closeBeforeTranscript = !transcriptSent;
        }
      });
    });

    const stt = makeStt({
      model: 'deepgram/nova-3',
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
    });
    const stream = stt.stream();
    let resolveTranscript!: () => void;
    const transcriptReceived = new Promise<void>((resolve) => {
      resolveTranscript = resolve;
    });
    const outputTask = (async () => {
      for await (const event of stream) {
        if (event.type === SpeechEventType.FINAL_TRANSCRIPT) {
          transcripts.push(event.alternatives![0].text);
          resolveTranscript();
        }
      }
    })();

    try {
      await sessionCreated;
      vi.useFakeTimers();
      stream.endInput();
      await finalizeReceived;
      await vi.advanceTimersByTimeAsync(25);
      await transcriptReceived;
      await vi.advanceTimersByTimeAsync(3_000);
      await outputTask;
      await socketClosed;

      expect(new URL(requestUrl!, 'ws://127.0.0.1').searchParams.get('model')).toBe(
        'deepgram/nova-3',
      );
      expect(messageTypes).toEqual(['session.create', 'session.finalize', 'session.close']);
      expect(transcripts).toEqual(['final words']);
      expect(closeBeforeTranscript).toBe(false);
    } finally {
      vi.useRealTimers();
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('closes the socket when the stream is closed while connecting', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const messageTypes: string[] = [];
    let resolveSocketClosed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      resolveSocketClosed = resolve;
    });

    const stt = makeStt({
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
    });
    const stream = stt.stream();

    server.on('connection', (socket) => {
      // The server sees the upgrade before the client's `open` fires, so this
      // lands while connectWs is still pending.
      stream.close();
      socket.on('close', resolveSocketClosed);
      socket.on('message', (raw) => {
        messageTypes.push((JSON.parse(raw.toString()) as { type: string }).type);
      });
    });

    try {
      const closedInTime = await Promise.race([
        socketClosed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);

      expect(closedInTime).toBe(true);
      expect(messageTypes).toEqual(['session.create', 'session.close']);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('finishes when session.closed follows input end', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const messageTypes: string[] = [];
    const transcripts: string[] = [];
    let sessionClosedSent = false;
    let socketClosedBeforeSessionClosed = false;
    let resolveSocketClosed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      resolveSocketClosed = resolve;
    });

    server.on('connection', (socket) => {
      socket.on('close', () => {
        socketClosedBeforeSessionClosed = !sessionClosedSent;
        resolveSocketClosed();
      });
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        messageTypes.push(event.type);
        if (event.type !== 'session.finalize') return;
        socket.send(
          JSON.stringify({
            type: 'final_transcript',
            transcript: 'final words',
            language: 'en',
          }),
        );
        sessionClosedSent = true;
        socket.send(JSON.stringify({ type: 'session.closed' }));
      });
    });

    const stt = makeStt({
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
    });
    const stream = stt.stream();

    try {
      stream.endInput();
      for await (const event of stream) {
        if (event.type === SpeechEventType.FINAL_TRANSCRIPT) {
          transcripts.push(event.alternatives![0].text);
        }
      }
      await socketClosed;

      expect(messageTypes).toEqual(['session.create', 'session.finalize']);
      expect(transcripts).toEqual(['final words']);
      expect(socketClosedBeforeSessionClosed).toBe(false);
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('accepts a socket close after input ends', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let connectionCount = 0;

    server.on('connection', (socket) => {
      connectionCount += 1;
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        if (event.type === 'session.finalize') socket.close(1011, 'finalization interrupted');
      });
    });

    const stt = makeStt({
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 3, retryIntervalMs: 1, timeoutMs: 1_000 },
    });
    const errors: Error[] = [];
    stt.on('error', ({ error }) => errors.push(error));
    const stream = stt.stream();

    try {
      stream.endInput();
      for await (const _ of stream) {
        /* drain */
      }

      expect(connectionCount).toBe(1);
      expect(errors).toHaveLength(0);
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reconnects when the socket closes before input ends', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let connectionCount = 0;
    let resolveSecondConnection!: () => void;
    const secondConnection = new Promise<void>((resolve) => {
      resolveSecondConnection = resolve;
    });

    server.on('connection', (socket) => {
      connectionCount += 1;
      const connection = connectionCount;
      if (connection === 2) resolveSecondConnection();
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        if (connection === 1 && event.type === 'session.create') {
          socket.send(JSON.stringify({ type: 'session.closed' }), () => socket.close());
        }
        if (connection === 2 && event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({
              type: 'final_transcript',
              transcript: 'final words',
              language: 'en',
            }),
          );
          socket.send(JSON.stringify({ type: 'session.closed' }));
        }
      });
    });

    const stt = makeStt({
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1_000 },
    });
    const stream = stt.stream();
    const transcripts: string[] = [];
    const outputTask = (async () => {
      for await (const event of stream) {
        if (event.type === SpeechEventType.FINAL_TRANSCRIPT) {
          transcripts.push(event.alternatives![0].text);
        }
      }
    })();

    try {
      await secondConnection;
      stream.endInput();
      await outputTask;

      expect(connectionCount).toBe(2);
      expect(transcripts).toEqual(['final words']);
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends an update queued while the initial connection opens', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const events: Array<{ type: string; settings?: { language?: string } }> = [];
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        events.push(JSON.parse(raw.toString()));
      });
    });
    const stt = makeStt({
      model: 'deepgram/nova-3',
      language: 'en',
      baseURL: `http://127.0.0.1:${port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
    });
    const connect = stt.connectWs.bind(stt);
    const pausedDial = withResolvers<void>();
    const finishDial = withResolvers<void>();
    const dial = vi.spyOn(stt, 'connectWs').mockImplementationOnce(async (...args) => {
      pausedDial.resolve();
      await finishDial.promise;
      return connect(...args);
    });
    const stream = stt.stream();
    try {
      await pausedDial.promise;
      stream.updateOptions({ language: normalizeLanguage('es') });
      finishDial.resolve();
      await vi.waitFor(() =>
        expect(events).toMatchObject([
          { type: 'session.create', settings: { language: 'en' } },
          { type: 'session.update', settings: { language: 'es' } },
        ]),
      );
    } finally {
      finishDial.resolve();
      dial.mockRestore();
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reconnects with accepted and pending settings after a rejected update', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const creates: Array<{ socket: WebSocket; settings: Record<string, unknown> }> = [];
    const updates: Record<string, unknown>[] = [];
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as {
          type: string;
          settings: Record<string, unknown>;
        };
        if (event.type === 'session.create') {
          creates.push({ socket, settings: event.settings });
          socket.send(JSON.stringify({ type: 'session.created' }));
        } else if (event.type === 'session.update') {
          updates.push(event.settings);
          if (updates.length === 1 || updates.length === 2) {
            socket.send(JSON.stringify({ type: 'session.updated', success: updates.length === 1 }));
          }
        }
      });
    });
    const stt = makeStt({
      model: 'deepgram/nova-3',
      language: 'en',
      baseURL: `http://127.0.0.1:${port}`,
      connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1_000 },
    });
    stt.on('error', () => {});
    const stream = stt.stream();
    try {
      await vi.waitFor(() => expect(creates).toHaveLength(1));
      stream.updateOptions({ language: normalizeLanguage('es') });
      stream.updateOptions({ language: normalizeLanguage('fr') });
      stream.updateOptions({ modelOptions: { keyterm: ['Acme'] } });
      await vi.waitFor(() => expect(updates).toHaveLength(3));
      creates[0]!.socket.close();
      await vi.waitFor(() => expect(creates).toHaveLength(2));
      expect(creates[1]!.settings).toMatchObject({ language: 'es', extra: { keyterm: ['Acme'] } });
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([false, true])(
    'reconnects with deferred keyterms (first redial fails: %s)',
    async (failFirstRedial) => {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(server, 'listening');
      const address = server.address() as AddressInfo;
      const created: Record<string, unknown>[] = [];
      let firstSocket: WebSocket | undefined;
      let updated!: () => void;
      const updateSeen = new Promise<void>((resolve) => {
        updated = resolve;
      });
      let reconnected!: () => void;
      const secondCreate = new Promise<void>((resolve) => {
        reconnected = resolve;
      });
      server.on('connection', (socket) => {
        socket.on('message', (raw) => {
          const event = JSON.parse(raw.toString()) as {
            type: string;
            settings?: { extra?: Record<string, unknown> };
          };
          if (event.type === 'session.create') {
            created.push(event.settings?.extra ?? {});
            socket.send(JSON.stringify({ type: 'session.created' }));
            if (created.length === 1) firstSocket = socket;
            else reconnected();
          } else if (event.type === 'session.update') updated();
        });
      });
      const stt = makeStt({
        model: 'deepgram/nova-3',
        modelOptions: { keyterm: ['Acme'] },
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 2, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      stt.on('error', () => {});
      const connect = stt.connectWs.bind(stt);
      const dial = vi.spyOn(stt, 'connectWs');
      if (failFirstRedial) {
        dial
          .mockImplementationOnce(connect)
          .mockRejectedValueOnce(new APIConnectionError({ message: 'first redial failed' }));
      }
      const stream = stt.stream();
      try {
        await vi.waitFor(() => expect(firstSocket).toBeDefined());
        stt._updateSessionKeyterms(['Stale']);
        await updateSeen;
        stream['speaking'] = true;
        stt._updateSessionKeyterms(['Fresh']);
        firstSocket!.close();
        await Promise.race([
          secondCreate,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('reconnect timeout')), 2000),
          ),
        ]);
        expect(dial).toHaveBeenCalledTimes(failFirstRedial ? 3 : 2);
        expect(created[1]!.keyterm).toEqual(['Acme', 'Fresh']);
      } finally {
        dial.mockRestore();
        stream.close();
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('does not require a final transcript after an interim', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const messageTypes: string[] = [];
    let resolveSessionCreated!: () => void;
    const sessionCreated = new Promise<void>((resolve) => {
      resolveSessionCreated = resolve;
    });

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        messageTypes.push(event.type);
        if (event.type === 'session.create') resolveSessionCreated();
        if (event.type === 'session.finalize') {
          socket.send(
            JSON.stringify({
              type: 'interim_transcript',
              transcript: 'interim words',
              language: 'en',
            }),
          );
        }
      });
    });

    const stt = makeStt({
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
    });
    const stream = stt.stream();
    let resolveTranscript!: () => void;
    const transcriptReceived = new Promise<void>((resolve) => {
      resolveTranscript = resolve;
    });
    const outputTask = (async () => {
      for await (const event of stream) {
        if (event.type === SpeechEventType.INTERIM_TRANSCRIPT) resolveTranscript();
      }
    })();

    try {
      await sessionCreated;
      vi.useFakeTimers();
      stream.endInput();
      await transcriptReceived;
      await vi.advanceTimersByTimeAsync(30_000);
      await outputTask;

      expect(messageTypes).toEqual(['session.create', 'session.finalize', 'session.close']);
    } finally {
      vi.useRealTimers();
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it(
    'does not let empty interims after finalize hold the stream open',
    { timeout: 15_000 },
    async () => {
      // the sequence recorded from the gateway for xai/stt-1: finals during the audio, then
      // after session.finalize an acknowledgment and an empty interim every second, for as long
      // as the socket is open. Real timers: the 3 s wait after a final is a fixed constant, and
      // the interims have to arrive over the socket while it runs
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await once(server, 'listening');
      const address = server.address() as AddressInfo;
      const messageTypes: string[] = [];
      let emptyInterims = 0;
      let interimTimer: ReturnType<typeof setInterval> | undefined;
      let finalizedAt = 0;
      let resolveSessionCreated!: () => void;
      const sessionCreated = new Promise<void>((resolve) => {
        resolveSessionCreated = resolve;
      });

      server.on('connection', (socket) => {
        socket.on('close', () => clearInterval(interimTimer));
        socket.on('message', (raw) => {
          const event = JSON.parse(raw.toString()) as { type: string };
          messageTypes.push(event.type);
          if (event.type === 'session.create') {
            resolveSessionCreated();
            socket.send(
              JSON.stringify({
                type: 'final_transcript',
                transcript: 'final words',
                language: 'en',
              }),
            );
          }
          if (event.type === 'session.finalize') {
            finalizedAt = Date.now();
            socket.send(JSON.stringify({ type: 'session.finalized' }));
            interimTimer = setInterval(() => {
              if (socket.readyState !== 1) return;
              emptyInterims++;
              socket.send(
                JSON.stringify({
                  type: 'interim_transcript',
                  transcript: '',
                  start: 50.753,
                  duration: 1.21,
                  language: 'en',
                }),
              );
            }, 700);
          }
        });
      });

      const stt = makeStt({
        model: 'xai/stt-1',
        baseURL: `http://127.0.0.1:${address.port}`,
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
      });
      const stream = stt.stream();
      const transcripts: string[] = [];
      let resolveTranscript!: () => void;
      const transcriptReceived = new Promise<void>((resolve) => {
        resolveTranscript = resolve;
      });
      const outputTask = (async () => {
        for await (const event of stream) {
          if (event.type === SpeechEventType.FINAL_TRANSCRIPT) {
            transcripts.push(event.alternatives![0].text);
            resolveTranscript();
          }
        }
      })();

      try {
        await sessionCreated;
        await transcriptReceived;
        stream.endInput();
        await outputTask;
        const endedAfter = Date.now() - finalizedAt;

        expect(messageTypes).toEqual(['session.create', 'session.finalize', 'session.close']);
        expect(transcripts).toEqual(['final words']);
        // interims kept arriving through the wait, and did not extend it past its 3 s
        expect(emptyInterims).toBeGreaterThanOrEqual(3);
        expect(endedAfter).toBeGreaterThanOrEqual(2_500);
        expect(endedAfter).toBeLessThan(5_000);
      } finally {
        clearInterval(interimTimer);
        stream.close();
        for (const client of server.clients) client.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('sends session.close and closes the socket when the stream closes', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const messageTypes: string[] = [];
    let resolveSessionCreated!: () => void;
    const sessionCreated = new Promise<void>((resolve) => {
      resolveSessionCreated = resolve;
    });
    let resolveSocketClosed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      resolveSocketClosed = resolve;
    });

    server.on('connection', (socket) => {
      socket.on('close', resolveSocketClosed);
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        messageTypes.push(event.type);
        if (event.type === 'session.create') resolveSessionCreated();
      });
    });

    const stt = makeStt({
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1_000 },
    });
    const stream = stt.stream();

    try {
      await sessionCreated;
      await new Promise<void>((resolve) => setImmediate(resolve));
      stream.close();
      await socketClosed;

      expect(messageTypes).toEqual(['session.create', 'session.close']);
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not retry an inactivity timeout', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    let connectionCount = 0;

    server.on('connection', (socket) => {
      connectionCount += 1;
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type: string };
        if (event.type !== 'session.finalize') return;
        socket.send(
          JSON.stringify({
            type: 'error',
            code: 2007,
            message: 'customer content must not reach the API error',
          }),
        );
      });
    });

    const stt = makeStt({
      baseURL: `http://127.0.0.1:${address.port}`,
      connOptions: { maxRetry: 3, retryIntervalMs: 1, timeoutMs: 1_000 },
    });
    const errors: Error[] = [];
    stt.on('error', ({ error }) => errors.push(error));
    const stream = stt.stream();

    try {
      stream.endInput();
      for await (const _ of stream) {
        /* drain */
      }

      expect(connectionCount).toBe(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(APIStatusError);
      expect(errors[0]).toMatchObject({
        message: 'LiveKit STT returned an error',
        statusCode: 2007,
        body: { code: 2007 },
        retryable: false,
      });
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Inference STT errors', () => {
  async function receiveGatewayError(gatewayError: Record<string, unknown>): Promise<Error> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    server.on('connection', (socket) => {
      socket.once('message', () => {
        setImmediate(() => socket.send(JSON.stringify(gatewayError)));
      });
    });

    const stt = makeStt({ baseURL: `http://127.0.0.1:${port}` });
    const errorPromise = new Promise<Error>((resolve) => {
      stt.once('error', ({ error }) => resolve(error));
    });
    const stream = stt.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 1_000 },
    });

    try {
      return await errorPromise;
    } finally {
      stream.close();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it.each([
    {
      gatewayError: {
        type: 'error',
        message: 'STT connection limit exceeded',
        code: 429,
        category: 'MaxConcurrentGatewaySTT',
        remaining_limit: 0,
      },
      statusCode: 429,
    },
    {
      gatewayError: { type: 'error', message: 'unknown gateway failure' },
      statusCode: -1,
    },
  ])('surfaces a mid-session gateway error with status $statusCode', async (testCase) => {
    const error = await receiveGatewayError(testCase.gatewayError);

    expect(error).toBeInstanceOf(APIStatusError);
    expect(error).toMatchObject({
      message: `LiveKit Inference STT returned error: ${testCase.gatewayError.message}`,
      statusCode: testCase.statusCode,
      body: testCase.gatewayError,
      retryable: true,
    });
  });
});

describeLiveKitInference('LiveKit Inference STT integration', agents, async (harness) => {
  for (const model of [
    'deepgram/nova-3',
    'cartesia/ink-whisper',
    'assemblyai/universal-streaming',
    'xai/stt-1',
  ] as const) {
    // each model is an independent gateway session: run the models, and both sample rates of
    // each, at the same time instead of one 50 s clip after another
    describe(model, { retry: 1, concurrent: true }, async () => {
      const stt =
        model === 'assemblyai/universal-streaming'
          ? new STT({ model, modelOptions: { format_turns: true } })
          : new STT({ model });
      await harness.stt(stt, new InferenceVAD(), {
        nonStreaming: false,
      });
    });
  }
});
