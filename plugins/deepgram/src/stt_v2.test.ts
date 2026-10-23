// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STTv2, type STTv2Options } from './stt_v2.js';

type TestSpeechStream = {
  updateOptions(opts: Partial<STTv2Options>): void;
  readonly _reconnectPending: boolean;
  _liveConfig(): Record<string, string | string[] | boolean>;
  close(): void;
};

function makeStream(opts: Partial<STTv2Options> = {}): TestSpeechStream {
  return new STTv2({ apiKey: 'test-api-key', ...opts }).stream() as unknown as TestSpeechStream;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Deepgram STTv2 connection options', () => {
  it.each([
    ['numerals', 'numerals', true],
    ['profanityFilter', 'profanity_filter', true],
    ['redact', 'redact', 'numbers'],
  ] as const)('reconnects when %s changes', (field, configField, value) => {
    const stream = makeStream();

    stream.updateOptions({ [field]: value });

    expect(stream._reconnectPending).toBe(true);
    expect(stream._liveConfig()[configField]).toBe(value);
    stream.close();
  });

  it('includes formatting fields in the connection config', () => {
    const stream = makeStream({
      numerals: true,
      profanityFilter: true,
      redact: 'aggressive_numbers',
    });

    expect(stream._liveConfig()).toMatchObject({
      numerals: true,
      profanity_filter: true,
      redact: 'aggressive_numbers',
    });
    stream.close();

    const defaultStream = makeStream();
    expect(defaultStream._liveConfig()).not.toHaveProperty('numerals');
    expect(defaultStream._liveConfig()).not.toHaveProperty('profanity_filter');
    expect(defaultStream._liveConfig()).not.toHaveProperty('redact');
    defaultStream.close();
  });
});

describe('Deepgram STTv2 language hints', () => {
  // Flux is the only model Deepgram accepts `language_hint` on: any other one is a 400 at
  // connect, so the option is kept but never sent.
  it('leaves the hint off the wire for a model that cannot take it', () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    const stream = makeStream({ model: 'flux-general-en', languageHint: ['en', 'es'] });

    expect(stream._liveConfig()).not.toHaveProperty('language_hint');
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      { model: 'flux-general-en' },
      'Ignoring `languageHint`: it is only supported by `flux-general-multi`',
    );
    stream.close();
  });

  it('sends the hint for flux-general-multi', () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    const stream = makeStream({ model: 'flux-general-multi', languageHint: ['en', 'es'] });

    expect(stream._liveConfig().language_hint).toEqual(['en', 'es']);
    expect(warnSpy).not.toHaveBeenCalled();
    stream.close();
  });

  it('leaves a hint a later update sets for a model that cannot take it off the wire', () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    const provider = new STTv2({ apiKey: 'test-api-key', model: 'flux-general-en' });
    const stream = provider.stream() as unknown as TestSpeechStream;

    provider.updateOptions({ languageHint: ['en', 'es'] });

    expect(stream._liveConfig()).not.toHaveProperty('language_hint');
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      { model: 'flux-general-en' },
      'Ignoring `languageHint`: it is only supported by `flux-general-multi`',
    );
    stream.close();
  });

  it('keeps a hint an update sets for flux-general-multi', () => {
    const provider = new STTv2({ apiKey: 'test-api-key', model: 'flux-general-multi' });
    const stream = provider.stream() as unknown as TestSpeechStream;

    provider.updateOptions({ languageHint: ['en'] });

    expect(stream._liveConfig().language_hint).toEqual(['en']);
    stream.close();
  });

  it('never puts the hint on the live config of a model that cannot take it', () => {
    const stream = makeStream({ model: 'flux-general-en' });

    stream.updateOptions({ languageHint: ['en', 'es'] });

    expect(stream._liveConfig()).not.toHaveProperty('language_hint');
    stream.close();
  });

  // A model switch only ever reaches a stream as a delta, so a hint cleared from the provider's
  // options left the existing stream and a new one disagreeing about the same configuration.
  it('sends the hint again when the model leaves flux-general-multi and comes back', () => {
    const warnSpy = vi.spyOn(log(), 'warn');
    const provider = new STTv2({
      apiKey: 'test-api-key',
      model: 'flux-general-multi',
      languageHint: ['es'],
    });
    const stream = provider.stream() as unknown as TestSpeechStream;

    expect(stream._liveConfig().language_hint).toEqual(['es']);

    provider.updateOptions({ model: 'flux-general-en' });
    expect(stream._liveConfig()).not.toHaveProperty('language_hint');

    provider.updateOptions({ model: 'flux-general-multi' });
    expect(stream._liveConfig().language_hint).toEqual(['es']);

    // the same configuration on a brand-new stream, which reads the provider's options directly
    const newStream = provider.stream() as unknown as TestSpeechStream;
    expect(newStream._liveConfig().language_hint).toEqual(['es']);

    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      { model: 'flux-general-en' },
      'Ignoring `languageHint`: it is only supported by `flux-general-multi`',
    );

    stream.close();
    newStream.close();
  });
});

const hasDeepgramApiKey = Boolean(process.env.DEEPGRAM_API_KEY);

if (hasDeepgramApiKey) {
  describe('Deepgram STTv2 (Flux)', async () => {
    await stt(new STTv2(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('Deepgram STTv2 (Flux)', () => {
    it.skip('requires DEEPGRAM_API_KEY', () => {});
  });
}
