// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log, mergeFrames, stt as sttLib } from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { type RequestListener, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT, type STTOptions } from './stt.js';

function makeFrame(samplesPerChannel = 800, sampleRate = 16000): AudioFrame {
  const data = new Int16Array(samplesPerChannel);
  data.fill(1);
  return new AudioFrame(data, sampleRate, 1, samplesPerChannel);
}

async function recognizeWords(words?: Record<string, unknown>[]) {
  const { server, baseURL } = await startHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'hello', language_code: 'en', words }));
  });

  try {
    return await new STT({ apiKey: 'test-key', baseURL }).recognize(makeFrame(), {
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
    });
  } finally {
    await closeHttpServer(server);
  }
}

async function startHttpServer(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
  return { server, baseURL: `http://127.0.0.1:${address.port}` };
}

async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseURL: `http://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

async function collectUntilEnd(stream: sttLib.SpeechStream): Promise<sttLib.SpeechEvent[]> {
  const events: sttLib.SpeechEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === sttLib.SpeechEventType.END_OF_SPEECH) break;
  }
  return events;
}

async function processStreamEvents(
  messages: Record<string, unknown>[],
  expectedEventCount: number,
  serverVad: { vadSilenceThresholdSecs: number } | null,
  options: STTOptions = {},
): Promise<sttLib.SpeechEvent[]> {
  const { wss, baseURL } = await startWebSocketServer();
  wss.on('connection', (ws) => {
    ws.once('message', () => {
      for (const message of messages) ws.send(JSON.stringify(message));
    });
  });

  const stream = new STT({
    apiKey: 'test-key',
    baseURL,
    model: 'scribe_v2_realtime',
    serverVad,
    ...options,
  }).stream();
  const events: sttLib.SpeechEvent[] = [];
  try {
    stream.pushFrame(makeFrame());
    for await (const event of stream) {
      events.push(event);
      if (events.length === expectedEventCount) break;
    }
    return events;
  } finally {
    stream.close();
    await closeWebSocketServer(wss);
  }
}

function partialTranscript(text: string): Record<string, unknown> {
  return { message_type: 'partial_transcript', text, words: [] };
}

function committedTranscript(
  text: string,
  options: {
    withTimestamps?: boolean;
    languageCode?: string;
    words?: Record<string, unknown>[];
  } = {},
): Record<string, unknown> {
  return {
    message_type: options.withTimestamps
      ? 'committed_transcript_with_timestamps'
      : 'committed_transcript',
    text,
    words: options.words ?? [],
    ...(options.languageCode !== undefined && { language_code: options.languageCode }),
  };
}

async function realtimeConnectionUrl(options: STTOptions = {}): Promise<URL> {
  const { wss, baseURL } = await startWebSocketServer();
  let requestUrl = '';
  wss.on('connection', (_ws, req) => {
    requestUrl = req.url ?? '';
  });

  const stream = new STT({
    apiKey: 'test-key',
    baseURL,
    model: 'scribe_v2_realtime',
    ...options,
  }).stream();
  try {
    await waitUntil(() => requestUrl !== '');
    return new URL(`ws://127.0.0.1${requestUrl}`);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 10));
    stream.close();
    await closeWebSocketServer(wss);
  }
}

function interimTexts(events: sttLib.SpeechEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === sttLib.SpeechEventType.INTERIM_TRANSCRIPT
      ? [event.alternatives?.[0]?.text ?? '']
      : [],
  );
}

const TRANSCRIPT =
  'It could not have been ten seconds, and yet it seemed a long time that their hands were clasped together.';

function normalizedWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function editDistance(left: string[], right: string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j++) {
      current[j + 1] = Math.min(
        current[j]! + 1,
        previous[j + 1]! + 1,
        previous[j]! + (left[i] === right[j] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function wordErrorRate(hypothesis: string, reference: string): number {
  const referenceWords = normalizedWords(reference);
  if (referenceWords.length === 0) return 0;
  return (
    editDistance(referenceWords, normalizedWords(hypothesis).slice(0, referenceWords.length)) /
    referenceWords.length
  );
}

function makeIntegrationSpeech(): AudioFrame {
  const sample = readFileSync(new URL('../../test/src/long.wav', import.meta.url));
  const channels = sample.readUInt16LE(22);
  const sampleRate = sample.readUInt32LE(24);
  const pcm = new Int16Array(sample.buffer, sample.byteOffset + 44, (sample.byteLength - 44) / 2);
  const frame = new AudioFrame(pcm, sampleRate, channels, Math.trunc(pcm.length / channels));

  if (sampleRate === 24000) return frame;

  const resampler = new AudioResampler(sampleRate, 24000, channels);
  const frames = resampler.push(frame);
  frames.push(...resampler.flush());
  resampler.close();
  return mergeFrames(frames);
}

const hasElevenLabsApiKey = Boolean(process.env.ELEVEN_API_KEY);

describe('ElevenLabs STT integration', () => {
  it.skipIf(!hasElevenLabsApiKey)(
    'recognizes speech with the real ElevenLabs API',
    async () => {
      const eleven = new STT();
      const event = await eleven.recognize(makeIntegrationSpeech(), {
        connOptions: { maxRetry: 2, retryIntervalMs: 2000, timeoutMs: 10000 },
      });

      expect(event.type).toBe(sttLib.SpeechEventType.FINAL_TRANSCRIPT);
      expect(wordErrorRate(event.alternatives?.[0]?.text ?? '', TRANSCRIPT)).toBeLessThanOrEqual(
        0.25,
      );
    },
    60_000,
  );
});

describe('ElevenLabs STT', () => {
  it('normalizes the primary language in the realtime connection URL', async () => {
    const url = await realtimeConnectionUrl({
      languageCode: 'en_US',
      secondaryLanguages: ['ru-RU'],
    });

    expect(url.searchParams.getAll('language_code')).toEqual(['en']);
    expect(url.searchParams.getAll('secondary_languages')).toEqual(['ru']);
  });

  it('includes secondary languages as repeated realtime query parameters', async () => {
    const url = await realtimeConnectionUrl({
      languageCode: 'en',
      secondaryLanguages: ['ru', 'es'],
    });

    expect(url.searchParams.get('language_code')).toBe('en');
    expect(url.searchParams.getAll('secondary_languages')).toEqual(['ru', 'es']);
  });

  it('normalizes secondary languages in the realtime connection URL', async () => {
    const url = await realtimeConnectionUrl({
      languageCode: 'en',
      secondaryLanguages: ['ru_RU', 'french', 'spa'],
    });

    expect(url.searchParams.getAll('secondary_languages')).toEqual(['ru', 'fr', 'es']);
  });

  it('omits secondary languages when not given', async () => {
    const url = await realtimeConnectionUrl({ languageCode: 'en' });

    expect(url.searchParams.has('secondary_languages')).toBe(false);
  });

  it('normalizes language options before serializing them', async () => {
    const url = await realtimeConnectionUrl({
      languageCode: 'en_US',
      secondaryLanguages: ['ru_RU', 'french', 'spa'],
    });

    expect(url.searchParams.get('language_code')).toBe('en');
    expect(url.searchParams.getAll('secondary_languages')).toEqual(['ru', 'fr', 'es']);
  });

  it('ignores secondary languages for batch models', () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);

    new STT({ apiKey: 'test-key', model: 'scribe_v2', secondaryLanguages: ['ru'] });

    expect(warn).toHaveBeenCalledWith(
      '`secondaryLanguages` is only supported for Scribe v2 realtime model and will be ignored',
    );
    warn.mockRestore();
  });

  it('requests language detection when no language is pinned', async () => {
    const url = await realtimeConnectionUrl();

    expect(url.searchParams.get('include_language_detection')).toBe('true');
  });

  it('omits language detection when a language is pinned', async () => {
    const url = await realtimeConnectionUrl({ languageCode: 'en' });

    expect(url.searchParams.has('include_language_detection')).toBe(false);
  });

  it('requests language detection when explicitly enabled', async () => {
    const url = await realtimeConnectionUrl({
      languageCode: 'en',
      includeLanguageDetection: true,
    });

    expect(url.searchParams.get('include_language_detection')).toBe('true');
  });

  it('omits language detection when explicitly disabled', async () => {
    const url = await realtimeConnectionUrl({ includeLanguageDetection: false });

    expect(url.searchParams.has('include_language_detection')).toBe(false);
  });

  it('reports the detected language on final transcripts', async () => {
    const events = await processStreamEvents(
      [
        committedTranscript('привет'),
        committedTranscript('привет', { withTimestamps: true, languageCode: 'ru' }),
      ],
      3,
      { vadSilenceThresholdSecs: 0.5 },
      { languageCode: 'en', secondaryLanguages: ['ru'], includeLanguageDetection: true },
    );

    const finals = events.filter((event) => event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.alternatives?.[0]?.language).toBe('ru');
  });

  it('reports autodetected languages without adding unrequested word timings', async () => {
    const events = await processStreamEvents(
      [
        committedTranscript('привет', {
          withTimestamps: true,
          languageCode: 'ru',
          words: [{ text: 'привет', start: 0.1, end: 0.4 }],
        }),
        committedTranscript('привет'),
      ],
      2,
      null,
    );

    const finals = events.filter((event) => event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.alternatives?.[0]?.language).toBe('ru');
    expect(finals[0]?.alternatives?.[0]?.words).toBeUndefined();
  });

  it('keeps the plain final transcript when detection is disabled', async () => {
    const events = await processStreamEvents(
      [committedTranscript('hola'), committedTranscript('hola', { withTimestamps: true })],
      2,
      null,
      { languageCode: 'es' },
    );

    const finals = events.filter((event) => event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.alternatives?.[0]?.language).toBe('es');
  });

  describe.each([
    'partial_transcript',
    'committed_transcript',
    'committed_transcript_with_timestamps',
  ] as const)('%s language', (messageType) => {
    it.each([
      ['es', {}, 'es'],
      ['es', { language_code: null }, 'es'],
      ['es', { language_code: '' }, 'es'],
      ['es', { language_code: 'fra' }, 'fr'],
      [undefined, {}, 'en'],
      [undefined, { language_code: null }, 'en'],
      [undefined, { language_code: '' }, 'en'],
      [undefined, { language_code: 'fra' }, 'fr'],
    ] as const)(
      'falls back from $1 with configured language $0 to $2',
      async (languageCode, languageData, expectedLanguage) => {
        const events = await processStreamEvents(
          [{ message_type: messageType, text: 'hola', ...languageData }],
          2,
          null,
          {
            languageCode,
            includeTimestamps: messageType === 'committed_transcript_with_timestamps',
            includeLanguageDetection: false,
          },
        );

        const transcript = events.at(-1);
        expect(transcript?.type).toBe(
          messageType === 'partial_transcript'
            ? sttLib.SpeechEventType.INTERIM_TRANSCRIPT
            : sttLib.SpeechEventType.FINAL_TRANSCRIPT,
        );
        expect(transcript?.alternatives?.[0]?.language).toBe(expectedLanguage);
      },
    );
  });

  it('forwards advancing partial transcripts', async () => {
    const events = await processStreamEvents(
      [partialTranscript('yeah'), partialTranscript('yeah please')],
      3,
      { vadSilenceThresholdSecs: 0.5 },
    );

    expect(interimTexts(events)).toEqual(['yeah', 'yeah please']);
  });

  it('drops re-sent partial transcripts', async () => {
    const events = await processStreamEvents(
      Array.from({ length: 5 }, () => partialTranscript('yeah please')),
      2,
      { vadSilenceThresholdSecs: 0.5 },
    );

    expect(interimTexts(events)).toEqual(['yeah please']);
    expect(events.map((event) => event.type)).toEqual([
      sttLib.SpeechEventType.START_OF_SPEECH,
      sttLib.SpeechEventType.INTERIM_TRANSCRIPT,
    ]);
  });

  it('forwards the same words again after a commit', async () => {
    const events = await processStreamEvents(
      [partialTranscript('right'), committedTranscript('right'), partialTranscript('right')],
      6,
      { vadSilenceThresholdSecs: 0.5 },
      { includeLanguageDetection: false },
    );

    expect(interimTexts(events)).toEqual(['right', 'right']);
  });

  it('forwards the same words again after an empty commit', async () => {
    const events = await processStreamEvents(
      [partialTranscript('right'), committedTranscript(''), partialTranscript('right')],
      5,
      null,
      { includeLanguageDetection: false },
    );

    expect(interimTexts(events)).toEqual(['right', 'right']);
  });

  it('calculates confidence from spoken-word logprobs', async () => {
    const event = await recognizeWords([
      { type: 'word', logprob: -0.01 },
      { type: 'spacing', logprob: -2 },
      { type: 'word', logprob: -0.05 },
    ]);

    expect(event.alternatives?.[0]?.confidence).toBeGreaterThan(0.9);
    expect(event.alternatives?.[0]?.confidence).toBeLessThanOrEqual(1);
  });

  it('flags low-quality transcription confidence', async () => {
    const event = await recognizeWords([
      { type: 'word', logprob: -2.5 },
      { type: 'word', logprob: -3 },
    ]);

    expect(event.alternatives?.[0]?.confidence).toBeLessThan(0.2);
  });

  it('defaults confidence to zero without logprobs', async () => {
    const withoutWords = await recognizeWords();
    const withoutLogprobs = await recognizeWords([{ text: 'hi', start: 0.1, end: 0.4 }]);

    expect(withoutWords.alternatives?.[0]?.confidence).toBe(0);
    expect(withoutLogprobs.alternatives?.[0]?.confidence).toBe(0);
  });

  it('sets confidence on committed transcripts', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let connected = false;

    wss.on('connection', (ws) => {
      connected = true;
      ws.on('message', () => {
        ws.send(
          JSON.stringify({
            message_type: 'committed_transcript',
            text: 'hello',
            words: [{ text: 'hello', start: 0.1, end: 0.4, type: 'word', logprob: -0.02 }],
          }),
        );
        ws.send(JSON.stringify({ message_type: 'committed_transcript', text: '' }));
      });
    });

    try {
      const stream = new STT({
        apiKey: 'test-key',
        baseURL,
        model: 'scribe_v2_realtime',
        serverVad: { vadSilenceThresholdSecs: 0.5 },
        includeLanguageDetection: false,
      }).stream();
      await waitUntil(() => connected);
      stream.pushFrame(makeFrame());
      stream.flush();
      stream.endInput();

      const events = await collectUntilEnd(stream);
      stream.close();
      const final = events.find((event) => event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT);
      expect(final?.alternatives?.[0]?.confidence).toBeGreaterThan(0.9);
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('defaults to Scribe v1 batch recognition', () => {
    const stt = new STT({ apiKey: 'test-key' });

    expect(stt.model).toBe('scribe_v1');
    expect(stt.provider).toBe('ElevenLabs');
    expect(stt.capabilities.streaming).toBe(false);
    expect(stt.capabilities.interimResults).toBe(true);
    expect(stt.capabilities.alignedTranscript).toBe(false);
  });

  it('maps deprecated useRealtime to realtime model capabilities', () => {
    const stt = new STT({ apiKey: 'test-key', useRealtime: true, includeTimestamps: true });

    expect(stt.model).toBe('scribe_v2_realtime');
    expect(stt.capabilities.streaming).toBe(true);
    expect(stt.capabilities.alignedTranscript).toBe('word');
  });

  it('sends batch recognition form fields and maps word metadata', async () => {
    let request:
      | {
          method?: string;
          url?: string;
          apiKey?: string | string[];
          body: string;
        }
      | undefined;

    const { server, baseURL } = await startHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        request = {
          method: req.method,
          url: req.url,
          apiKey: req.headers['xi-api-key'],
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            text: 'bonjour livekit',
            language_code: 'fr',
            words: [
              { text: 'bonjour', start: 0.2, end: 0.7, speaker_id: 'speaker-a' },
              { text: 'livekit', start: 0.8, end: 1.1, speaker_id: 'speaker-a' },
            ],
          }),
        );
      });
    });

    try {
      const eleven = new STT({
        apiKey: 'test-key',
        baseURL,
        languageCode: 'en',
        tagAudioEvents: false,
        model: 'scribe_v2',
        keyterms: ['LiveKit', 'ElevenLabs'],
      });

      const event = await eleven.recognize(makeFrame(), {
        language: 'fr',
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
      });

      expect(request?.method).toBe('POST');
      expect(request?.url).toBe('/speech-to-text?enable_logging=true');
      expect(request?.apiKey).toBe('test-key');
      expect(request?.body).toContain('name="model_id"');
      expect(request?.body).toContain('scribe_v2');
      expect(request?.body).toContain('name="tag_audio_events"');
      expect(request?.body).toContain('false');
      expect(request?.body).toContain('name="language_code"');
      expect(request?.body).toContain('fr');
      expect(request?.body.match(/name="keyterms"/g)).toHaveLength(2);

      expect(event.type).toBe(sttLib.SpeechEventType.FINAL_TRANSCRIPT);
      expect(event.alternatives?.[0]).toMatchObject({
        text: 'bonjour livekit',
        language: 'fr',
        speakerId: 'speaker-a',
        startTime: 0.2,
        endTime: 1.1,
      });
      expect(event.alternatives?.[0]?.words?.map((word) => word.text)).toEqual([
        'bonjour',
        'livekit',
      ]);
    } finally {
      await closeHttpServer(server);
    }
  });

  it('streams audio and maps realtime speech events', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const receivedMessages: Record<string, unknown>[] = [];
    let requestUrl = '';
    let requestApiKey: string | string[] | undefined;

    wss.on('connection', (ws, req) => {
      requestUrl = req.url ?? '';
      requestApiKey = req.headers['xi-api-key'];
      let sentEvents = false;
      ws.on('message', (raw) => {
        receivedMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
        if (sentEvents) return;
        sentEvents = true;
        ws.send(JSON.stringify({ message_type: 'session_started', session_id: 'session-1' }));
        ws.send(
          JSON.stringify({ message_type: 'partial_transcript', text: 'hel', language_code: 'en' }),
        );
        ws.send(
          JSON.stringify({
            message_type: 'committed_transcript_with_timestamps',
            text: 'hello',
            language_code: 'en',
            words: [{ text: 'hello', start: 0.1, end: 0.4 }],
          }),
        );
        ws.send(JSON.stringify({ message_type: 'committed_transcript_with_timestamps', text: '' }));
        setTimeout(() => ws.close(), 20);
      });
    });

    try {
      const eleven = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v2_realtime' });
      const stream = eleven.stream();
      stream.startTimeOffset = 1;

      await waitUntil(() => requestUrl !== '');

      stream.pushFrame(makeFrame());
      stream.flush();
      stream.endInput();

      const events = await collectUntilEnd(stream);
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(requestApiKey).toBe('test-key');
      expect(url.pathname).toBe('/speech-to-text/realtime');
      expect(url.searchParams.get('model_id')).toBe('scribe_v2_realtime');
      expect(url.searchParams.get('audio_format')).toBe('pcm_16000');
      expect(url.searchParams.get('commit_strategy')).toBe('manual');
      expect(url.searchParams.get('include_language_detection')).toBe('true');
      expect(receivedMessages[0]).toMatchObject({
        message_type: 'input_audio_chunk',
        commit: false,
        sample_rate: 16000,
      });
      expect(typeof receivedMessages[0]?.audio_base_64).toBe('string');

      const speechEvents = events.filter(
        (event) => event.type !== sttLib.SpeechEventType.RECOGNITION_USAGE,
      );
      expect(speechEvents.map((event) => event.type)).toEqual([
        sttLib.SpeechEventType.START_OF_SPEECH,
        sttLib.SpeechEventType.INTERIM_TRANSCRIPT,
        sttLib.SpeechEventType.FINAL_TRANSCRIPT,
        sttLib.SpeechEventType.END_OF_SPEECH,
      ]);
      expect(events.some((event) => event.type === sttLib.SpeechEventType.RECOGNITION_USAGE)).toBe(
        true,
      );
      expect(speechEvents[2]?.alternatives?.[0]).toMatchObject({
        text: 'hello',
        language: 'en',
        startTime: 1.1,
        endTime: 1.4,
      });
      expect(speechEvents[2]?.alternatives?.[0]?.words).toBeUndefined();
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('commits the turn when no audio is left to send', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const sent: Record<string, unknown>[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => sent.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
    }).stream();
    try {
      // 50ms is exactly one repack chunk, so flush() returns no frames.
      stream.pushFrame(makeFrame());
      await waitUntil(() => sent.length === 1);

      stream.flush();
      await waitUntil(() => sent.length === 2);

      expect(sent.map((message) => message.commit)).toEqual([false, true]);
      expect(sent[1]?.audio_base_64).toBe('');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('commits after the buffered audio', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const sent: Record<string, unknown>[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => sent.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
    }).stream();
    try {
      stream.pushFrame(makeFrame(480));
      stream.flush();
      await waitUntil(() => sent.length === 2);

      expect(sent.map((message) => message.commit)).toEqual([false, true]);
      expect(sent[0]?.audio_base_64).not.toBe('');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('defaults audio chunks to 50ms', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const sent: Record<string, unknown>[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => sent.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
    }).stream();
    try {
      stream.pushFrame(makeFrame(784));
      stream.flush();
      await waitUntil(() => sent.some((message) => message.commit === true));
      expect(sent.map((message) => message.commit)).toEqual([false, true]);
      expect(Buffer.from(sent[0]?.audio_base_64 as string, 'base64')).toHaveLength(1568);

      stream.pushFrame(makeFrame());
      await waitUntil(() => sent.length === 3);
      expect(sent[2]?.commit).toBe(false);
      expect(Buffer.from(sent[2]?.audio_base_64 as string, 'base64')).toHaveLength(1600);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it.each([0, -1, 0.5, 100.5, true, false, null, '100'])(
    'rejects invalid audio chunk duration %j',
    (audioChunkDuration) => {
      expect(
        () =>
          new STT({
            apiKey: 'test-key',
            audioChunkDuration: audioChunkDuration as number,
          }),
      ).toThrow('audioChunkDuration must be a positive integer');
    },
  );

  for (const sampleRate of [8000, 16000, 48000] as const) {
    for (const audioChunkDuration of [1, 50, 75, 100, 200]) {
      for (const tailDuration of [0, 1]) {
        it(`preserves ${sampleRate}Hz audio with ${audioChunkDuration}ms chunks and ${tailDuration}ms tail`, async () => {
          const { wss, baseURL } = await startWebSocketServer();
          const sent: Record<string, unknown>[] = [];
          wss.on('connection', (ws) => {
            ws.on('message', (raw) =>
              sent.push(JSON.parse(raw.toString()) as Record<string, unknown>),
            );
          });

          const stream = new STT({
            apiKey: 'test-key',
            baseURL,
            model: 'scribe_v2_realtime',
            sampleRate,
            audioChunkDuration,
          }).stream();
          const totalSamples = Math.floor(
            (sampleRate * (audioChunkDuration * 2 + tailDuration)) / 1000,
          );
          const audio = Buffer.from(
            Array.from({ length: totalSamples * 2 }, (_, index) => index % 251),
          );
          const inputFrameBytes = Math.floor((sampleRate * 20) / 1000) * 2;
          const chunkBytes = Math.floor((sampleRate * audioChunkDuration) / 1000) * 2;
          const expectedChunks = Array.from(
            { length: Math.ceil(audio.length / chunkBytes) },
            (_, index) => audio.subarray(index * chunkBytes, (index + 1) * chunkBytes),
          );

          try {
            for (let offset = 0; offset < audio.length; offset += inputFrameBytes) {
              const data = audio.subarray(offset, offset + inputFrameBytes);
              stream.pushFrame(
                new AudioFrame(
                  new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2),
                  sampleRate,
                  1,
                  data.byteLength / 2,
                ),
              );
            }

            await waitUntil(() => sent.length >= Math.floor(audio.length / chunkBytes));
            stream.flush();
            await waitUntil(() => sent.length >= expectedChunks.length + 1);

            expect(sent.slice(0, -1).map((message) => message.audio_base_64)).toEqual(
              expectedChunks.map((chunk) => chunk.toString('base64')),
            );
            expect(sent.map((message) => message.commit)).toEqual([
              ...expectedChunks.map(() => false),
              true,
            ]);
            expect(sent.every((message) => message.sample_rate === sampleRate)).toBe(true);
            expect(sent.at(-1)?.audio_base_64).toBe('');
          } finally {
            stream.close();
            await closeWebSocketServer(wss);
          }
        });
      }
    }
  }

  it('builds realtime query params for language, timestamps, and server VAD', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let requestUrl = '';

    wss.on('connection', (ws, req) => {
      requestUrl = req.url ?? '';
      ws.on('message', () => {
        ws.send(JSON.stringify({ message_type: 'committed_transcript', text: 'ignored' }));
        ws.send(
          JSON.stringify({
            message_type: 'committed_transcript_with_timestamps',
            text: 'kept',
            language_code: 'en',
            words: [{ text: 'kept', start: 0, end: 0.2 }],
          }),
        );
      });
    });

    try {
      const eleven = new STT({
        apiKey: 'test-key',
        baseURL,
        model: 'scribe_v2_realtime',
        languageCode: 'en',
        includeTimestamps: true,
        serverVad: {
          vadSilenceThresholdSecs: 0.5,
          vadThreshold: 0.4,
          minSpeechDurationMs: 100,
          minSilenceDurationMs: 300,
        },
      });
      const stream = eleven.stream();

      await waitUntil(() => requestUrl !== '');

      stream.pushFrame(makeFrame());
      stream.endInput();

      const events = await collectUntilEnd(stream);
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(url.searchParams.get('language_code')).toBe('en');
      expect(url.searchParams.get('commit_strategy')).toBe('vad');
      expect(url.searchParams.get('include_language_detection')).toBeNull();
      expect(url.searchParams.get('include_timestamps')).toBe('true');
      expect(url.searchParams.get('vad_silence_threshold_secs')).toBe('0.5');
      expect(url.searchParams.get('vad_threshold')).toBe('0.4');
      expect(url.searchParams.get('min_speech_duration_ms')).toBe('100');
      expect(url.searchParams.get('min_silence_duration_ms')).toBe('300');
      expect(
        events.find((event) => event.type === sttLib.SpeechEventType.FINAL_TRANSCRIPT)
          ?.alternatives?.[0]?.text,
      ).toBe('kept');
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('includes keyterms in the realtime connection URL', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let requestUrl = '';
    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
      keyterms: ['nginx', 'Grafana Loki', 'Ærø'],
    }).stream();
    try {
      await waitUntil(() => requestUrl !== '');

      expect(requestUrl).toContain('keyterms=nginx');
      expect(requestUrl).toContain('keyterms=Grafana%20Loki');
      expect(requestUrl).toContain('keyterms=%C3%86r%C3%B8');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('escapes query delimiters in realtime keyterms', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let requestUrl = '';
    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
      keyterms: ['Smith & Sons', 'C#'],
    }).stream();
    try {
      await waitUntil(() => requestUrl !== '');

      expect(requestUrl).toContain('keyterms=Smith%20%26%20Sons');
      expect(requestUrl).toContain('keyterms=C%23');
      expect(new URL(`ws://127.0.0.1${requestUrl}`).searchParams.getAll('keyterms')).toEqual([
        'Smith & Sons',
        'C#',
      ]);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('omits realtime keyterms when not provided', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    let requestUrl = '';
    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    const stream = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v2_realtime' }).stream();
    try {
      await waitUntil(() => requestUrl !== '');

      expect(requestUrl).not.toContain('keyterms=');
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('forwards keyterm updates to active streams', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const urls: string[] = [];
    wss.on('connection', (_ws, req) => {
      urls.push(req.url ?? '');
    });

    const eleven = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v2_realtime' });
    const stream = eleven.stream();
    try {
      await waitUntil(() => urls.length === 1);
      eleven.updateOptions({ keyterms: ['nginx'] });
      await waitUntil(() => urls.length === 2, 2000);

      expect(new URL(`ws://127.0.0.1${urls[1]}`).searchParams.getAll('keyterms')).toEqual([
        'nginx',
      ]);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('updates stream keyterms and reconnects', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const urls: string[] = [];
    wss.on('connection', (_ws, req) => {
      urls.push(req.url ?? '');
    });

    const stream = new STT({
      apiKey: 'test-key',
      baseURL,
      model: 'scribe_v2_realtime',
    }).stream();
    try {
      await waitUntil(() => urls.length === 1);
      stream.updateOptions({ keyterms: ['nginx'] });
      await waitUntil(() => urls.length === 2, 2000);

      expect(new URL(`ws://127.0.0.1${urls[1]}`).searchParams.getAll('keyterms')).toEqual([
        'nginx',
      ]);
    } finally {
      stream.close();
      await closeWebSocketServer(wss);
    }
  });

  it('updates server VAD on active streams and reconnects in place', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const urls: string[] = [];

    wss.on('connection', (ws, req) => {
      urls.push(req.url ?? '');
      ws.on('message', () => {});
    });

    try {
      const eleven = new STT({ apiKey: 'test-key', baseURL, model: 'scribe_v2_realtime' });
      const stream = eleven.stream();

      await waitUntil(() => urls.length === 1);
      eleven.updateOptions({ serverVad: { vadSilenceThresholdSecs: 0.5 } });
      await waitUntil(() => urls.length === 2, 2000);
      eleven.updateOptions({ serverVad: null });
      await waitUntil(() => urls.length === 3, 2000);
      stream.close();

      const first = new URL(`ws://127.0.0.1${urls[0]}`);
      const second = new URL(`ws://127.0.0.1${urls[1]}`);
      const third = new URL(`ws://127.0.0.1${urls[2]}`);
      expect(first.searchParams.get('commit_strategy')).toBe('manual');
      expect(second.searchParams.get('commit_strategy')).toBe('vad');
      expect(third.searchParams.get('commit_strategy')).toBe('manual');
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});
