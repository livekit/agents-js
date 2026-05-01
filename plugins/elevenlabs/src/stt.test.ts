// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { mergeFrames, stt as sttLib } from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { type RequestListener, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';

function makeFrame(samplesPerChannel = 800, sampleRate = 16000): AudioFrame {
  const data = new Int16Array(samplesPerChannel);
  data.fill(1);
  return new AudioFrame(data, sampleRate, 1, samplesPerChannel);
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
        modelId: 'scribe_v2',
        keyterms: ['LiveKit', 'ElevenLabs'],
      });

      const event = await eleven.recognize(makeFrame(), {
        language: 'fr',
        connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
      });

      expect(request?.method).toBe('POST');
      expect(request?.url).toBe('/speech-to-text');
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
            message_type: 'committed_transcript',
            text: 'hello',
            language_code: 'en',
            words: [{ text: 'hello', start: 0.1, end: 0.4 }],
          }),
        );
        ws.send(JSON.stringify({ message_type: 'committed_transcript', text: '' }));
        setTimeout(() => ws.close(), 20);
      });
    });

    try {
      const eleven = new STT({ apiKey: 'test-key', baseURL, modelId: 'scribe_v2_realtime' });
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
      expect(url.searchParams.get('commit_strategy')).toBe('vad');
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
      expect(speechEvents[2]?.alternatives?.[0]?.words?.[0]).toMatchObject({
        text: 'hello',
        startTime: 1.1,
        endTime: 1.4,
        startTimeOffset: 1,
      });
    } finally {
      await closeWebSocketServer(wss);
    }
  });

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
        ws.send(JSON.stringify({ message_type: 'committed_transcript_with_timestamps', text: '' }));
      });
    });

    try {
      const eleven = new STT({
        apiKey: 'test-key',
        baseURL,
        modelId: 'scribe_v2_realtime',
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

  it('updates server VAD on active streams and reconnects in place', async () => {
    const { wss, baseURL } = await startWebSocketServer();
    const urls: string[] = [];

    wss.on('connection', (ws, req) => {
      urls.push(req.url ?? '');
      ws.on('message', () => {});
    });

    try {
      const eleven = new STT({ apiKey: 'test-key', baseURL, modelId: 'scribe_v2_realtime' });
      const stream = eleven.stream();

      await waitUntil(() => urls.length === 1);
      eleven.updateOptions({ serverVad: null });
      await waitUntil(() => urls.length === 2, 2000);
      stream.close();

      const first = new URL(`ws://127.0.0.1${urls[0]}`);
      const second = new URL(`ws://127.0.0.1${urls[1]}`);
      expect(first.searchParams.get('commit_strategy')).toBe('vad');
      expect(second.searchParams.get('commit_strategy')).toBe('manual');
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});
