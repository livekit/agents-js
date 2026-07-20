// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as agents from '../index.js';
import { normalizeLanguage } from '../language.js';
import { AgentHandoffItem, ChatMessage } from '../llm/index.js';
import { initializeLogger, log } from '../log.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { VAD, type VADStream } from '../vad.js';
import { createConversationItemAddedEvent } from '../voice/events.js';
import {
  STT,
  type STTFallbackModel,
  type XaiSTTModels,
  normalizeSTTFallback,
  parseSTTModelString,
} from './stt.js';
import { describeLiveKitInference } from './test_utils.js';
import { VAD as InferenceVAD } from './vad.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe('STT agent_context carryover', () => {
  it('agentContextCarryover defaults to enabled on AssemblyAI U3 Pro family models', () => {
    for (const model of ['assemblyai/u3-rt-pro', 'assemblyai/universal-3-5-pro'] as const) {
      const stt = makeAssemblyStt({ model });
      expect(stt.capabilities.chatContext).toBe(true);
    }
  });

  it('agentContextCarryover defaults off for unsupported models without warning', () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    const stt = makeAssemblyStt({ model: 'assemblyai/universal-streaming' });

    expect(stt.capabilities.chatContext).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('agentContextCarryover is off for non-AssemblyAI models', () => {
    const stt = makeAssemblyStt({ model: 'deepgram/nova-3' });
    expect(stt.capabilities.chatContext).toBe(false);
  });

  it('explicit true on unsupported model warns and is ignored', () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    const stt = makeAssemblyStt({
      model: 'assemblyai/universal-streaming',
      agentContextCarryover: true,
    });

    expect(stt.capabilities.chatContext).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      { model: 'assemblyai/universal-streaming' },
      'agentContextCarryover is enabled but model does not support it; ignoring',
    );
  });

  it('explicit false disables carryover on a supported model', () => {
    const stt = makeAssemblyStt({
      agentContextCarryover: false,
      modelOptions: { agent_context: 'keep me' },
    });
    expect(stt.capabilities.chatContext).toBe(false);

    stt._pushConversationItem(assistantItemEvent('do not forward me'));

    expect(stt['opts'].modelOptions).toHaveProperty('agent_context', 'keep me');
  });

  it('previous_context_n_turns=0 disables the default carryover', () => {
    const stt = makeAssemblyStt({ modelOptions: { previous_context_n_turns: 0 } });
    expect(stt.capabilities.chatContext).toBe(false);
  });

  it('explicit true wins over previous_context_n_turns=0', () => {
    const stt = makeAssemblyStt({
      modelOptions: { previous_context_n_turns: 0 },
      agentContextCarryover: true,
    });
    expect(stt.capabilities.chatContext).toBe(true);
  });

  it('forwards short assistant replies verbatim', () => {
    const stt = makeAssemblyStt();
    const stream = stt.stream();

    stt._pushConversationItem(assistantItemEvent('Your room is booked for Tuesday.'));

    expect(stt['opts'].modelOptions).toHaveProperty(
      'agent_context',
      'Your room is booked for Tuesday.',
    );
    expect(stream['opts'].modelOptions).toHaveProperty(
      'agent_context',
      'Your room is booked for Tuesday.',
    );
    stream.close();
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

  it('starts forwarding after changing from an unsupported to a supported model', () => {
    const stt = makeAssemblyStt({ model: 'assemblyai/universal-streaming' });

    stt._pushConversationItem(assistantItemEvent('ignored before transition'));
    expect(stt['opts'].modelOptions).not.toHaveProperty('agent_context');

    stt.updateOptions({ model: 'assemblyai/universal-3-5-pro' });
    stt._pushConversationItem(assistantItemEvent('forwarded after transition'));

    expect(stt['opts'].modelOptions).toHaveProperty('agent_context', 'forwarded after transition');
  });

  it('stops forwarding after changing from a supported to an unsupported model', () => {
    const stt = makeAssemblyStt();
    stt._pushConversationItem(assistantItemEvent('last supported context'));

    stt.updateOptions({ model: 'assemblyai/universal-streaming' });
    stt._pushConversationItem(assistantItemEvent('ignored after transition'));

    expect(stt['opts'].modelOptions).toHaveProperty('agent_context', 'last supported context');
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
