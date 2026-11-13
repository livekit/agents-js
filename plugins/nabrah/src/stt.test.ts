// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIStatusError, type TimedString, stt } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STT, type STTOptions, type SpeechStream } from './stt.js';

interface StreamInternals {
  audioPosition: number;
  utteranceFlushedClean: string;
  utteranceFlushedWords: number;
  utteranceWords: TimedString[];
  opts: STTOptions;
  nabrahLogger: { warn: (message: string) => void };
  processMessage(data: Record<string, unknown>): void;
  currentText(): string;
  streamFailure(message: string): Error & { retryable: boolean };
  flushEos(): void;
  handleMessage(message: string): void;
  emit(event: stt.SpeechEvent): void;
}

const streams: SpeechStream[] = [];

function newStream(): [SpeechStream, StreamInternals] {
  const stream = new STT({ apiKey: 'test-key' }).stream();
  streams.push(stream);
  return [stream, stream as unknown as StreamInternals];
}

afterEach(() => {
  for (const stream of streams.splice(0)) stream.close();
});

describe('Nabrah STT', () => {
  it('starts a new utterance when a closed utterance prefix is repeated', () => {
    const [, stream] = newStream();
    stream.processMessage({
      type: 'transcript',
      text: 'مرحبا',
      is_final: true,
      audio_processed: 1,
    });
    stream.processMessage({
      type: 'transcript',
      text: 'مرحبا بكم',
      is_final: false,
      audio_processed: 2,
    });

    expect(stream.currentText()).toBe('مرحبا مرحبا بكم');
  });

  it('replaces a previous open-utterance hypothesis with its correction', () => {
    const [, stream] = newStream();
    stream.processMessage({ type: 'transcript', text: 'مرحبا بكم', is_final: false });
    stream.processMessage({ type: 'transcript', text: 'مرحبا بكن', is_final: false });

    expect(stream.currentText()).toBe('مرحبا بكن');
  });

  it('preserves provider punctuation in a flushed prefix', () => {
    const [, stream] = newStream();
    stream.opts.endOfTurnConfirmDelay = null;
    stream.processMessage({
      type: 'transcript',
      text: 'مرحبا <eot>',
      is_final: false,
      audio_processed: 1,
    });
    stream.processMessage({
      type: 'transcript',
      text: 'مرحبا. كيف <eot>',
      is_final: false,
      audio_processed: 2,
    });

    expect(stream.utteranceFlushedClean).toBe('مرحبا. كيف');

    stream.processMessage({
      type: 'transcript',
      text: 'مرحبا. كيف حالك',
      is_final: false,
      audio_processed: 3,
    });
    expect(stream.currentText()).toBe('حالك');
  });

  it('does not move the raw word cursor backwards for a filtered word', () => {
    const [, stream] = newStream();
    stream.opts.endOfTurnConfirmDelay = null;
    stream.processMessage({
      type: 'transcript',
      text: 'مرحبا <eot>',
      words: [{ word: 'مرحبا' }, { word: '<eot>' }],
    });

    expect(stream.utteranceFlushedWords).toBe(2);

    stream.processMessage({
      type: 'transcript',
      text: 'مرحبا <eot> كيف',
      words: [{ word: 'مرحبا' }, { word: '<eot>' }, { word: 'كيف' }],
    });
    expect(stream.utteranceWords.map((word) => word.text)).toEqual(['كيف']);
  });

  it('does not expose provider content in provider errors', () => {
    const [, stream] = newStream();
    const transcript = 'private customer transcript';

    expect(() => stream.processMessage({ type: 'error', message: transcript })).toThrowError(
      APIStatusError,
    );
    try {
      stream.processMessage({ type: 'error', message: transcript });
    } catch (error) {
      expect(String(error)).not.toContain(transcript);
    }
  });

  it('does not expose provider content from malformed messages', () => {
    const [, stream] = newStream();
    const transcript = 'private customer transcript';
    const warning = vi.spyOn(stream.nabrahLogger, 'warn').mockImplementation(() => {});
    const process = vi.spyOn(stream, 'processMessage').mockImplementation(() => {
      throw new Error(transcript);
    });

    stream.handleMessage(JSON.stringify({ type: 'transcript', text: transcript }));

    expect(process).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('Nabrah STT returned malformed data');
    expect(warning.mock.calls.flat().join(' ')).not.toContain(transcript);
  });

  it('does not retry stream failures after audio is consumed', () => {
    const [, stream] = newStream();
    expect(stream.streamFailure('failed').retryable).toBe(true);

    stream.audioPosition = 0.1;

    expect(stream.streamFailure('failed').retryable).toBe(false);
  });

  it.each([
    ['is_final', 'false'],
    ['audio_processed', Number.NaN],
  ])('rejects an invalid %s transcript field', (field, value) => {
    const [, stream] = newStream();
    expect(() =>
      stream.processMessage({ type: 'transcript', text: 'مرحبا', [field]: value }),
    ).toThrow();
  });

  it('reports usage when flushing without a transcript', () => {
    const [, stream] = newStream();
    const emitted: stt.SpeechEvent[] = [];
    stream.audioPosition = 1.25;
    vi.spyOn(stream, 'emit').mockImplementation((event) => emitted.push(event));

    stream.flushEos();

    const usageEvents = emitted.filter(
      (event) => event.type === stt.SpeechEventType.RECOGNITION_USAGE,
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.recognitionUsage?.audioDuration).toBeCloseTo(1.25);
  });
});
