// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  ChatMessage,
  DEFAULT_API_CONNECT_OPTIONS,
  createConversationItemAddedEvent,
  stt,
} from '@livekit/agents';
import { stt as testStt } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import { decode, encode } from '@msgpack/msgpack';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';
import { STT, type SpeechStream, _closeCodeToStatus } from './stt.js';

type WireMessage = Record<string, unknown>;
type HistoryItem = { role: string; text: string };
type Cleanup = () => void | Promise<void>;

const cleanups: Cleanup[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  const sockets: WebSocket[] = [];
  const messages: WireMessage[][] = [];
  wss.on('connection', (socket) => {
    sockets.push(socket);
    const socketMessages: WireMessage[] = [];
    messages.push(socketMessages);
    socket.on('message', (raw) =>
      socketMessages.push(decode(Buffer.from(raw as ArrayBuffer)) as WireMessage),
    );
  });
  cleanups.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  return { wss, sockets, messages, baseURL: `http://127.0.0.1:${address.port}` };
}

class EventCollector {
  readonly events: stt.SpeechEvent[] = [];
  readonly done: Promise<void>;

  constructor(stream: SpeechStream) {
    this.done = (async () => {
      for await (const event of stream) this.events.push(event);
    })();
  }

  async waitFor(count: number): Promise<stt.SpeechEvent[]> {
    await waitUntil(() => this.events.length >= count);
    return this.events;
  }
}

async function makeStream(
  opts: ConstructorParameters<typeof STT>[0] = {},
  connOptions: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
) {
  const server = await createServer();
  const fish = new STT({ apiKey: 'test-key', baseURL: server.baseURL, ...opts });
  const stream = fish.stream({ connOptions });
  const collector = new EventCollector(stream);
  cleanups.push(async () => {
    await fish.close();
    await collector.done;
  });
  await waitUntil(() => server.sockets.length === 1 && (server.messages[0]?.length ?? 0) >= 1);
  return { fish, stream, collector, socket: server.sockets[0]!, ...server };
}

function send(socket: WebSocket, message: WireMessage): void {
  socket.send(encode(message));
}

function committed(overrides: WireMessage = {}): WireMessage {
  return {
    type: 'committed',
    turn_index: 0,
    text: "Hi, I'd like to book a table.",
    words: [
      { text: 'Hi', start_ms: 500, end_ms: 900 },
      { text: 'table', start_ms: 2100, end_ms: 2500 },
    ],
    language_code: 'en',
    audio_start_ms: 256,
    audio_end_ms: 3600,
    reason: 'eot',
    degraded: false,
    user_turn: true,
    turn_kind: 'user',
    ...overrides,
  };
}

function sendUserTurn(socket: WebSocket, turnIndex = 0): void {
  send(socket, { type: 'speech_start', turn_index: turnIndex, audio_ms: 256 });
  send(socket, { type: 'user_turn_taken', turn_index: turnIndex, audio_ms: 900 });
}

function silence(durationMs: number, sampleRate = 16000): AudioFrame {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  return new AudioFrame(new Int16Array(samples), sampleRate, 1, samples);
}

function noRetry(timeoutMs = 1000): APIConnectOptions {
  return { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0, retryIntervalMs: 0, timeoutMs };
}

function assistant(text: string) {
  return createConversationItemAddedEvent(new ChatMessage({ role: 'assistant', content: text }));
}

function user(text: string) {
  return createConversationItemAddedEvent(new ChatMessage({ role: 'user', content: text }));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Fish Audio STT turn events', () => {
  it('test_auto_mode_waits_for_user_turn_taken', async () => {
    const { socket, collector } = await makeStream();
    send(socket, { type: 'speech_start', turn_index: 0, audio_ms: 256 });
    send(socket, { type: 'draft', turn_index: 0, text: 'Hi,', audio_ms: 880 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collector.events).toEqual([]);

    send(socket, { type: 'user_turn_taken', turn_index: 0, audio_ms: 1280 });
    const events = await collector.waitFor(2);
    expect(events.map((event) => event.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.INTERIM_TRANSCRIPT,
    ]);
    expect(events[1]?.alternatives?.[0].text).toBe('Hi,');
  });

  it('test_auto_mode_turn_events', async () => {
    const { socket, collector } = await makeStream();
    sendUserTurn(socket);
    send(socket, { type: 'draft', turn_index: 0, text: "Hi, I'd like", audio_ms: 1600 });
    send(socket, {
      type: 'eager_end_of_turn',
      turn_index: 0,
      text: "Hi, I'd like to book a table.",
      language_code: 'en',
      audio_ms: 3000,
    });
    send(socket, committed());

    const events = await collector.waitFor(5);
    expect(events.map((event) => event.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.INTERIM_TRANSCRIPT,
      stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
    expect(events[2]?.alternatives?.[0].text).toBe("Hi, I'd like to book a table.");
    const final = events[3]!.alternatives![0];
    expect(final).toMatchObject({
      text: "Hi, I'd like to book a table.",
      language: 'en',
      startTime: 0.5,
      endTime: 2.5,
    });
    expect(final.words?.map((word) => word.text)).toEqual(['Hi', 'table']);
    expect(events[4]?.alternatives?.[0].endTime).toBe(2.5);
  });

  it('test_timestamps_follow_the_stream_offset', async () => {
    const { stream, socket, collector, messages } = await makeStream();
    stream.startTimeOffset = 2;
    stream.pushFrame(silence(20));
    await waitUntil(() => messages[0]!.some((message) => message.type === 'audio'));
    const audioStartedAt = Date.now();
    sendUserTurn(socket);
    send(socket, committed());

    const events = await collector.waitFor(3);
    expect(events[0]!.createdAt).toBeGreaterThanOrEqual(audioStartedAt - 50 + 256);
    expect(events[0]!.createdAt).toBeLessThanOrEqual(audioStartedAt + 50 + 256);
    const final = events[1]!.alternatives![0];
    expect(final.startTime).toBe(2.5);
    expect(final.endTime).toBe(4.5);
    expect(final.words?.[0]?.startTime).toBe(2.5);
    expect(events[2]!.speechEndTime).toBeGreaterThanOrEqual(audioStartedAt - 50 + 2500);
    expect(events[2]!.speechEndTime).toBeLessThanOrEqual(audioStartedAt + 50 + 2500);
  });

  it('test_auto_mode_ignores_turns_that_are_not_the_users', async () => {
    const { socket, collector } = await makeStream();
    send(socket, { type: 'speech_start', turn_index: 0, audio_ms: 256 });
    send(socket, { type: 'draft', turn_index: 0, text: '[noise]', audio_ms: 500 });
    send(socket, committed({ user_turn: false, turn_kind: 'other', text: 'mm' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collector.events).toEqual([]);
  });

  it('test_non_user_commit_after_start_closes_the_turn', async () => {
    const { socket, collector } = await makeStream();
    sendUserTurn(socket);
    send(socket, committed({ user_turn: false, turn_kind: 'other' }));
    expect((await collector.waitFor(2)).map((event) => event.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
  });

  it('test_user_commit_without_user_turn_taken_still_starts_the_turn', async () => {
    const { socket, collector } = await makeStream();
    send(socket, { type: 'speech_start', turn_index: 0, audio_ms: 256 });
    send(socket, committed());
    expect((await collector.waitFor(3)).map((event) => event.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
  });

  it('test_empty_user_turn_still_sends_a_final_transcript', async () => {
    const { socket, collector } = await makeStream({ turnDetectionMode: 'manual' });
    send(socket, { type: 'speech_start', turn_index: 0, audio_ms: 256 });
    send(socket, committed({ text: '', words: [], reason: 'finalize' }));
    const events = await collector.waitFor(3);
    expect(events.map((event) => event.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
    expect(events[1]?.alternatives?.[0].text).toBe('');
  });

  it('test_vad_mode_starts_turn_on_speech_start', async () => {
    const { socket, collector } = await makeStream({ turnDetectionMode: 'vad' });
    send(socket, { type: 'speech_start', turn_index: 0, audio_ms: 384 });
    send(socket, { type: 'draft', turn_index: 0, text: 'Hi', audio_ms: 900 });
    expect((await collector.waitFor(2)).map((event) => event.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.INTERIM_TRANSCRIPT,
    ]);
  });

  it('test_messages_for_other_turns_are_ignored', async () => {
    const { socket, collector } = await makeStream();
    sendUserTurn(socket, 1);
    await collector.waitFor(1);
    send(socket, { type: 'draft', turn_index: 0, text: 'stale', audio_ms: 10 });
    send(socket, { type: 'eager_end_of_turn', turn_index: 0, text: 'stale' });
    send(socket, committed({ turn_index: 0, user_turn: false, turn_kind: 'other' }));
    send(socket, { type: 'draft', turn_index: 1, text: 'still here' });
    const events = await collector.waitFor(3);
    expect(events.at(-1)?.type).toBe(stt.SpeechEventType.INTERIM_TRANSCRIPT);
    expect(events.at(-1)?.alternatives?.[0].text).toBe('still here');
    expect(events.some((event) => event.alternatives?.[0].text === 'stale')).toBe(false);
  });

  it('test_degraded_commit_uses_turn_bounds', async () => {
    const { socket, collector } = await makeStream();
    sendUserTurn(socket);
    const msg = committed({ degraded: true });
    delete msg.words;
    send(socket, msg);
    const events = await collector.waitFor(3);
    expect(events[1]?.alternatives?.[0]).toMatchObject({ startTime: 0.256, endTime: 3.6 });
    expect(events[1]?.alternatives?.[0].words).toBeUndefined();
    expect(events[2]?.alternatives).toBeUndefined();
  });

  it('test_committed_user_turn_is_kept_as_context', async () => {
    const { socket, sockets, messages } = await makeStream();
    send(socket, committed());
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.close(1012);
    await waitUntil(() => sockets.length === 2 && (messages[1]?.length ?? 0) >= 1);
    expect((messages[1]![0]!.context as WireMessage).history).toEqual([
      { role: 'user', text: "Hi, I'd like to book a table." },
    ]);
  });

  it('test_session_started_sets_ids', async () => {
    const { socket, collector } = await makeStream();
    send(socket, { type: 'session_started', session_id: 's_1', request_id: 'r_1' });
    sendUserTurn(socket);
    expect((await collector.waitFor(1))[0]?.requestId).toBe('r_1');
  });

  it('test_errors', async () => {
    const recoverable = await makeStream({}, noRetry());
    send(recoverable.socket, {
      type: 'error',
      code: 503,
      error_type: 'engine_error',
      recoverable: true,
    });
    send(recoverable.socket, {
      type: 'error',
      code: 503,
      error_type: 'server_restarting',
      recoverable: true,
    });
    send(recoverable.socket, {
      type: 'error',
      code: 413,
      error_type: 'max_duration_exceeded',
      recoverable: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recoverable.stream.terminalError).toBeUndefined();

    const invalid = await makeStream({}, noRetry());
    const invalidError = once(invalid.fish, 'error');
    send(invalid.socket, {
      type: 'error',
      code: 400,
      error_type: 'invalid_config',
      message: 'bad config',
      recoverable: false,
    });
    const [{ error: invalidApiError }] = (await invalidError) as Parameters<
      stt.STTCallbacks['error']
    >;
    expect(invalidApiError).toBeInstanceOf(APIStatusError);
    expect((invalidApiError as APIStatusError).statusCode).toBe(400);
    expect((invalidApiError as APIStatusError).retryable).toBe(false);

    const internal = await makeStream({}, noRetry());
    const internalError = once(internal.fish, 'error');
    send(internal.socket, {
      type: 'error',
      code: 500,
      error_type: 'internal',
      recoverable: false,
    });
    const [{ error: internalApiError }] = (await internalError) as Parameters<
      stt.STTCallbacks['error']
    >;
    expect(internalApiError).toBeInstanceOf(APIStatusError);
    expect((internalApiError as APIStatusError).retryable).toBe(true);
  });

  it('test_close_code_to_status', () => {
    expect(_closeCodeToStatus(4400)).toBe(400);
    expect(_closeCodeToStatus(4408)).toBe(408);
    expect(_closeCodeToStatus(1006)).toBe(-1);
  });
});

describe('Fish Audio STT options', () => {
  it('test_default_config', async () => {
    const { messages } = await makeStream();
    expect(messages[0]![0]).toEqual({
      type: 'config',
      protocol_version: 1,
      audio: { format: 'pcm_s16le', sample_rate: 16000, channels: 1 },
      turn_detection: { mode: 'auto', eager: true },
      results: {
        drafts: true,
        ignore_timestamps: false,
        diarize: false,
        tag_audio_events: false,
      },
    });
  });

  it('test_vad_config', async () => {
    const { messages } = await makeStream({
      turnDetectionMode: 'vad',
      silenceTimeoutMs: 500,
      interimResults: false,
    });
    const config = messages[0]![0]!;
    expect(config.turn_detection).toEqual({ mode: 'vad', silence_timeout_ms: 500 });
    expect((config.results as WireMessage).drafts).toBe(false);
  });

  it('test_sample_rate_validated', () => {
    expect(() => new STT({ apiKey: 'test-key', sampleRate: 11025 })).toThrow();
    expect(() => new STT({ apiKey: 'test-key', sampleRate: 8000 })).not.toThrow();
  });

  it('test_silence_timeout_validated_per_mode', () => {
    expect(() => new STT({ apiKey: 'test-key', silenceTimeoutMs: 700 })).toThrow();
    expect(
      () => new STT({ apiKey: 'test-key', turnDetectionMode: 'vad', silenceTimeoutMs: 700 }),
    ).not.toThrow();
    const fish = new STT({ apiKey: 'test-key' });
    expect(() => fish.updateOptions({ silenceTimeoutMs: 100 })).toThrow();
  });

  it('test_keyterms_are_sanitized', async () => {
    const { messages } = await makeStream({
      keyterms: ['LiveKit', ' LiveKit ', '', 'x'.repeat(33), 'Fish Audio'],
    });
    expect((messages[0]![0]!.context as WireMessage).terms).toEqual(['LiveKit', 'Fish Audio']);
  });

  it('test_keyterms_are_capped', async () => {
    const terms = Array.from({ length: 120 }, (_, index) => `term ${index}`);
    const { messages } = await makeStream({ keyterms: terms });
    expect((messages[0]![0]!.context as WireMessage).terms).toEqual(terms.slice(0, 100));
  });

  it('test_keyterm_updates_are_sent_to_active_streams', async () => {
    const { fish, messages } = await makeStream({ keyterms: ['LiveKit'] });
    fish._updateSessionKeyterms(['Fish Audio']);
    await waitUntil(() => messages[0]!.length >= 2);
    expect(messages[0]![1]).toEqual({
      type: 'configure',
      context: { terms: ['LiveKit', 'Fish Audio'] },
    });

    fish.updateOptions({ keyterms: ['Agents'], silenceTimeoutMs: 4000 });
    await waitUntil(() => messages[0]!.length >= 3);
    expect(messages[0]![2]).toEqual({
      type: 'configure',
      turn_detection: { silence_timeout_ms: 4000 },
      context: { terms: ['Agents', 'Fish Audio'] },
    });
  });

  it('test_eager_update_is_dropped_outside_auto_mode', async () => {
    const { fish, messages } = await makeStream({ turnDetectionMode: 'vad' });
    fish.updateOptions({ eagerEot: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(messages[0]).toHaveLength(1);
  });

  it('test_agent_replies_are_sent_as_context', async () => {
    const { fish, messages } = await makeStream();
    fish._pushConversationItem(user('hello'));
    fish._pushConversationItem(assistant('What time?'));
    await waitUntil(() => messages[0]!.length >= 2);
    expect(messages[0]![1]).toEqual({
      type: 'context_add',
      items: [{ role: 'assistant', text: 'What time?' }],
    });

    const second = fish.stream();
    const secondCollector = new EventCollector(second);
    cleanups.push(async () => {
      second.close();
      await secondCollector.done;
    });
    await waitUntil(() => messages.length === 2 && (messages[1]?.length ?? 0) >= 1);
    expect((messages[1]![0]!.context as WireMessage).history).toEqual([
      { role: 'assistant', text: 'What time?' },
    ]);
  });

  it('test_user_turns_stay_with_their_stream', async () => {
    const { fish, socket, messages } = await makeStream();
    send(socket, committed());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = fish.stream();
    const secondCollector = new EventCollector(second);
    cleanups.push(async () => {
      second.close();
      await secondCollector.done;
    });
    await waitUntil(() => messages.length === 2 && (messages[1]?.length ?? 0) >= 1);
    expect(messages[1]![0]).not.toHaveProperty('context');
  });

  it('test_context_is_kept_while_disconnected', async () => {
    const server = await createServer();
    const fish = new STT({ apiKey: 'test-key', baseURL: server.baseURL });
    const stream = fish.stream();
    const collector = new EventCollector(stream);
    cleanups.push(async () => {
      await fish.close();
      await collector.done;
    });
    fish._pushConversationItem(assistant('What time?'));
    await waitUntil(() => (server.messages[0]?.length ?? 0) >= 1);
    expect((server.messages[0]![0]!.context as WireMessage).history).toEqual([
      { role: 'assistant', text: 'What time?' },
    ]);
    expect(server.messages[0]).toHaveLength(1);
  });

  it('test_history_is_capped', async () => {
    const server = await createServer();
    const fish = new STT({ apiKey: 'test-key', baseURL: server.baseURL });
    for (let index = 0; index < 40; index++) {
      fish._pushConversationItem(assistant(`${index} ${'x'.repeat(2500)}`));
    }
    const stream = fish.stream();
    const collector = new EventCollector(stream);
    cleanups.push(async () => {
      await fish.close();
      await collector.done;
    });
    await waitUntil(() => (server.messages[0]?.length ?? 0) >= 1);
    const history = (server.messages[0]![0]!.context as WireMessage).history as HistoryItem[];
    expect(history).toHaveLength(32);
    expect(history.every((item) => item.text.length === 2000)).toBe(true);
  });
});

describe('Fish Audio STT wire protocol', () => {
  it('test_wire_protocol_in_manual_mode', async () => {
    const { stream, socket, collector, messages } = await makeStream({
      turnDetectionMode: 'manual',
    });
    stream.pushFrame(silence(30));
    stream.flush();
    await waitUntil(() => messages[0]!.some((message) => message.type === 'finalize'));
    expect(messages[0]![0]!.turn_detection).toEqual({ mode: 'manual' });
    expect(messages[0]!.slice(1).map((message) => message.type)).toEqual([
      'audio',
      'audio',
      'finalize',
    ]);
    expect((messages[0]![1]!.data as Uint8Array).byteLength).toBe(640);
    expect((messages[0]![2]!.data as Uint8Array).byteLength).toBe(320);

    stream.endInput();
    await waitUntil(() => messages[0]!.some((message) => message.type === 'audio_done'));
    send(socket, { type: 'session_done', stats: { audio_ms: 30, turns: 0 } });
    socket.close(1000);
    await collector.done;
    const usage = collector.events.filter(
      (event) => event.type === stt.SpeechEventType.RECOGNITION_USAGE,
    );
    expect(
      usage.reduce((sum, event) => sum + event.recognitionUsage!.audioDuration, 0),
    ).toBeCloseTo(0.03);
  });

  it('test_flush_finalizes_the_turn_in_auto_mode', async () => {
    const { stream, messages } = await makeStream();
    stream.pushFrame(silence(20));
    stream.flush();
    await waitUntil(() => messages[0]!.some((message) => message.type === 'finalize'));
    expect(messages[0]![0]!.turn_detection).toMatchObject({ mode: 'auto' });
  });

  it('test_flush_with_an_open_turn_waits_for_the_commit', async () => {
    const { stream, socket, collector, messages } = await makeStream();
    send(socket, { type: 'speech_start', turn_index: 0, audio_ms: 100 });
    stream.pushFrame(silence(20));
    stream.flush();
    await waitUntil(() => messages[0]!.some((message) => message.type === 'finalize'));
    send(socket, committed({ reason: 'finalize' }));
    stream.endInput();
    await waitUntil(() => messages[0]!.some((message) => message.type === 'audio_done'));
    socket.close(1000);
    await collector.done;
    const transcripts = collector.events.filter(
      (event) => event.type !== stt.SpeechEventType.RECOGNITION_USAGE,
    );
    expect(transcripts.map((event) => event.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
    expect(transcripts[1]?.alternatives?.[0].text).toBe("Hi, I'd like to book a table.");
  });

  it('test_server_restart_starts_a_new_session_with_the_conversation', async () => {
    const { fish, socket, sockets, messages } = await makeStream();
    fish._pushConversationItem(assistant('What time?'));
    send(socket, { type: 'session_started', session_id: 's_1', request_id: 'r_1' });
    send(socket, { type: 'speech_start', turn_index: 0, audio_ms: 100 });
    send(socket, { type: 'user_turn_taken', turn_index: 0, audio_ms: 300 });
    send(socket, committed({ text: 'Seven thirty.' }));
    send(socket, { type: 'error', code: 503, error_type: 'server_restarting' });
    socket.close(1012);
    await waitUntil(() => sockets.length === 2 && (messages[1]?.length ?? 0) >= 1);
    expect((messages[1]![0]!.context as WireMessage).history).toEqual([
      { role: 'assistant', text: 'What time?' },
      { role: 'user', text: 'Seven thirty.' },
    ]);
  });

  it('test_session_ending_before_any_speech_raises_a_retryable_error', async () => {
    const { fish, socket } = await makeStream({}, noRetry());
    const errorEvent = once(fish, 'error');
    socket.close(1012);
    const [{ error }] = (await errorEvent) as Parameters<stt.STTCallbacks['error']>;
    expect(error).toBeInstanceOf(APIConnectionError);
    expect((error as APIConnectionError).retryable).toBe(true);
  });

  it('test_failed_config_send_raises_a_connection_error', async () => {
    const server = await createServer();
    server.wss.prependListener('connection', (socket) => socket.terminate());
    const fish = new STT({ apiKey: 'test-key', baseURL: server.baseURL });
    const errorEvent = once(fish, 'error');
    const stream = fish.stream({ connOptions: noRetry() });
    const collector = new EventCollector(stream);
    cleanups.push(async () => {
      await fish.close();
      await collector.done;
    });
    const [{ error }] = (await errorEvent) as Parameters<stt.STTCallbacks['error']>;
    expect(error).toBeInstanceOf(APIConnectionError);
  });

  it('test_idle_session_at_maximum_duration_starts_a_new_one', async () => {
    const { socket, sockets, messages } = await makeStream({}, noRetry());
    socket.close(4413);
    await waitUntil(() => sockets.length === 2 && (messages[1]?.length ?? 0) >= 1);
    expect(messages[1]![0]!.type).toBe('config');
  });

  it('test_closing_the_stt_closes_its_streams', async () => {
    const { fish, stream, socket, collector } = await makeStream();
    const closed = once(socket, 'close');
    await fish.close();
    await closed;
    await collector.done;
    expect(socket.readyState).toBe(socket.CLOSED);
    expect(stream.terminalError).toBeUndefined();
  });

  it('test_invalid_config_close_is_not_retried', async () => {
    const { fish, socket, sockets } = await makeStream({}, noRetry());
    const errorEvent = once(fish, 'error');
    socket.close(4400);
    const [{ error }] = (await errorEvent) as Parameters<stt.STTCallbacks['error']>;
    expect(error).toBeInstanceOf(APIStatusError);
    expect((error as APIStatusError).statusCode).toBe(400);
    expect(sockets).toHaveLength(1);
  });

  it('test_dropped_connection_ends_the_open_turn', async () => {
    const { fish, socket, collector } = await makeStream({ turnDetectionMode: 'vad' }, noRetry());
    send(socket, { type: 'speech_start', turn_index: 0, audio_ms: 100 });
    send(socket, { type: 'draft', turn_index: 0, text: 'Book a table for' });
    await collector.waitFor(2);
    const errorEvent = once(fish, 'error');
    socket.terminate();
    await errorEvent;
    const events = await collector.waitFor(4);
    expect(events.map((event) => event.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.INTERIM_TRANSCRIPT,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
    expect(events[2]?.alternatives?.[0].text).toBe('Book a table for');
  });
});

if (process.env.FISH_API_KEY) {
  describe('Fish Audio STT generic integration', async () => {
    await testStt(new STT(), undefined as never, { nonStreaming: false });
  });
} else {
  describe('Fish Audio STT generic integration', () => {
    it.skip('test_stream requires FISH_API_KEY', () => {});
  });
}
