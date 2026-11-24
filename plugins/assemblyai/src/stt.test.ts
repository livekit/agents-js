// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log, stt } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt as runSTTTests } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { STT } from './stt.js';

const MANUAL_MODEL = 'assemblyai-stt-3-7-realtime-agent';
const FORCE_ENDPOINT = { type: 'ForceEndpoint' };

async function startWebSocketServer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const address = wss.address() as AddressInfo;
  return { wss, baseUrl: `ws://127.0.0.1:${address.port}` };
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.close();
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

function frame(ms: number, sample = 1): AudioFrame {
  const samples = (16000 * ms) / 1000;
  return new AudioFrame(new Int16Array(samples).fill(sample), 16000, 1, samples);
}

function durationMs(chunk: Buffer): number {
  return chunk.byteLength / 32;
}

async function withStream(
  opts: ConstructorParameters<typeof STT>[0],
  check: (
    stream: ReturnType<STT['stream']>,
    messages: Array<Buffer | Record<string, unknown>>,
    socket: WebSocket,
  ) => Promise<void>,
): Promise<void> {
  const { wss, baseUrl } = await startWebSocketServer();
  const messages: Array<Buffer | Record<string, unknown>> = [];
  let socket: WebSocket | undefined;
  wss.on('connection', (connected) => {
    socket = connected;
    connected.on('message', (data, binary) => {
      messages.push(binary ? Buffer.from(data as Buffer) : JSON.parse(data.toString()));
    });
  });
  const stream = new STT({ apiKey: 'test-key', baseUrl, ...opts }).stream();
  try {
    await waitUntil(() => socket !== undefined);
    await check(stream, messages, socket!);
  } finally {
    stream.close();
    await closeWebSocketServer(wss);
  }
}

describe('AssemblyAI options', () => {
  it('accepts manual mode on assemblyai-stt-3-7-realtime-agent', () => {
    const provider = new STT({ apiKey: 'test-key', speechModel: MANUAL_MODEL, mode: 'manual' });
    expect(provider.model).toBe(MANUAL_MODEL);
    expect(provider.capabilities.manualFlush).toBe(true);
  });

  it('accepts manual mode with the deprecated u3-pro alias', () => {
    const provider = new STT({ apiKey: 'test-key', speechModel: 'u3-pro', mode: 'manual' });
    expect(provider.model).toBe(MANUAL_MODEL);
    expect(provider.capabilities.manualFlush).toBe(true);
  });

  it.each(['u3-rt-pro', 'u3-rt-pro-beta-1', 'universal-3-5-pro', 'universal-3-6-pro'] as const)(
    'rejects manual mode on %s',
    (speechModel) => {
      expect(() => new STT({ apiKey: 'test-key', speechModel, mode: 'manual' })).toThrow(/manual/);
    },
  );

  it('rejects manual mode on universal streaming', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          speechModel: 'universal-streaming-english',
          mode: 'manual',
        }),
    ).toThrow(/mode/);
  });

  it('rejects manual mode with speaker labels', () => {
    expect(() => new STT({ apiKey: 'test-key', mode: 'manual', speakerLabels: true })).toThrow(
      /speakerLabels/,
    );
  });

  it('allows speaker labels outside manual mode', () => {
    expect(
      new STT({ apiKey: 'test-key', mode: 'balanced', speakerLabels: true }).capabilities
        .diarization,
    ).toBe(true);
  });

  it.each([undefined, 'min_latency', 'balanced', 'max_accuracy'] as const)(
    'does not advertise manual flush for mode %s',
    (mode) => {
      expect(new STT({ apiKey: 'test-key', mode }).capabilities.manualFlush).toBe(false);
    },
  );

  it('accepts u3-rt-pro-beta-1', () => {
    const stt = new STT({ apiKey: 'test-key', speechModel: 'u3-rt-pro-beta-1' });

    expect(stt.model).toBe('u3-rt-pro-beta-1');
  });

  it('accepts u3-pro parameters for u3-rt-pro-beta-1', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          speechModel: 'u3-rt-pro-beta-1',
          prompt: 'medical dictation',
          agentContext: "The agent asked for the patient's name.",
          previousContextNTurns: 10,
        }),
    ).not.toThrow();
  });

  it('accepts universal-3-6-pro', () => {
    const stt = new STT({ apiKey: 'test-key', speechModel: 'universal-3-6-pro' });

    expect(stt.model).toBe('universal-3-6-pro');
  });

  it('accepts u3-pro parameters for universal-3-6-pro', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let requestUrl = '';

    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    try {
      const stream = new STT({
        apiKey: 'test-key',
        baseUrl,
        speechModel: 'universal-3-6-pro',
        prompt: 'medical dictation',
        agentContext: "The agent asked for the patient's name.",
        previousContextNTurns: 10,
        interruptionDelay: 300,
        voiceFocus: 'near-field',
        mode: 'max_accuracy',
        languageCodes: ['en', 'es'],
      }).stream();

      await waitUntil(() => requestUrl !== '');
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(url.searchParams.get('speech_model')).toBe('universal-3-6-pro');
      expect(url.searchParams.get('prompt')).toBe('medical dictation');
      expect(url.searchParams.get('agent_context')).toBe("The agent asked for the patient's name.");
      expect(url.searchParams.get('previous_context_n_turns')).toBe('10');
      expect(url.searchParams.get('interruption_delay')).toBe('300');
      expect(url.searchParams.get('voice_focus')).toBe('near-field');
      expect(url.searchParams.get('mode')).toBe('max_accuracy');
      expect(JSON.parse(url.searchParams.get('language_codes')!)).toEqual(['en', 'es']);
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('applies u3-pro connection defaults to universal-3-6-pro', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let requestUrl = '';

    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    try {
      const stream = new STT({
        apiKey: 'test-key',
        baseUrl,
        speechModel: 'universal-3-6-pro',
      }).stream();

      await waitUntil(() => requestUrl !== '');
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(url.searchParams.get('speech_model')).toBe('universal-3-6-pro');
      expect(url.searchParams.get('min_turn_silence')).toBe('100');
      expect(url.searchParams.get('max_turn_silence')).toBe('100');
      expect(url.searchParams.get('language_detection')).toBe('true');
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('accepts assemblyai-stt-3-7-realtime-agent', () => {
    const stt = new STT({
      apiKey: 'test-key',
      speechModel: 'assemblyai-stt-3-7-realtime-agent',
    });

    expect(stt.model).toBe('assemblyai-stt-3-7-realtime-agent');
  });

  it('accepts u3-pro parameters for assemblyai-stt-3-7-realtime-agent', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let requestUrl = '';

    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    try {
      const stream = new STT({
        apiKey: 'test-key',
        baseUrl,
        speechModel: 'assemblyai-stt-3-7-realtime-agent',
        prompt: 'medical dictation',
        agentContext: "The agent asked for the patient's name.",
        previousContextNTurns: 10,
        continuousPartials: true,
        interruptionDelay: 300,
        voiceFocus: 'near-field',
        voiceFocusThreshold: 0.5,
        mode: 'max_accuracy',
        languageCodes: ['en', 'es'],
      }).stream();

      await waitUntil(() => requestUrl !== '');
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(url.searchParams.get('speech_model')).toBe('assemblyai-stt-3-7-realtime-agent');
      expect(url.searchParams.get('prompt')).toBe('medical dictation');
      expect(url.searchParams.get('agent_context')).toBe("The agent asked for the patient's name.");
      expect(url.searchParams.get('previous_context_n_turns')).toBe('10');
      expect(url.searchParams.get('continuous_partials')).toBe('true');
      expect(url.searchParams.get('interruption_delay')).toBe('300');
      expect(url.searchParams.get('voice_focus')).toBe('near-field');
      expect(url.searchParams.get('voice_focus_threshold')).toBe('0.5');
      expect(url.searchParams.get('mode')).toBe('max_accuracy');
      expect(JSON.parse(url.searchParams.get('language_codes')!)).toEqual(['en', 'es']);
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('applies u3-pro connection defaults to assemblyai-stt-3-7-realtime-agent', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let requestUrl = '';

    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    try {
      const stream = new STT({
        apiKey: 'test-key',
        baseUrl,
        speechModel: 'assemblyai-stt-3-7-realtime-agent',
      }).stream();

      await waitUntil(() => requestUrl !== '');
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(url.searchParams.get('speech_model')).toBe('assemblyai-stt-3-7-realtime-agent');
      expect(url.searchParams.get('min_turn_silence')).toBe('100');
      expect(url.searchParams.get('max_turn_silence')).toBe('100');
      expect(url.searchParams.get('language_detection')).toBe('true');
    } finally {
      await closeWebSocketServer(wss);
    }
  });

  it('defaults to assemblyai-stt-3-7-realtime-agent', () => {
    const stt = new STT({ apiKey: 'test-key' });

    expect(stt.model).toBe('assemblyai-stt-3-7-realtime-agent');
  });

  it('accepts u3-pro parameters with the deprecated alias', () => {
    const stt = new STT({ apiKey: 'test-key', speechModel: 'u3-pro', continuousPartials: true });

    expect(stt.model).toBe('assemblyai-stt-3-7-realtime-agent');
  });

  it('warns and rewrites the deprecated u3-pro alias to the default model', () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);

    try {
      const stt = new STT({ apiKey: 'test-key', speechModel: 'u3-pro' });

      expect(stt.model).toBe('assemblyai-stt-3-7-realtime-agent');
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain('assemblyai-stt-3-7-realtime-agent');
    } finally {
      warn.mockRestore();
    }
  });

  it('limits assemblyai-stt-3-7-realtime-agent to 10 language codes', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          speechModel: 'assemblyai-stt-3-7-realtime-agent',
          languageCodes: ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'ko'],
        }),
    ).toThrow(/at most 10/);
  });

  it('allows family-only options for every u3-pro family model', () => {
    const models = [
      'u3-rt-pro',
      'u3-rt-pro-beta-1',
      'universal-3-5-pro',
      'universal-3-6-pro',
      'assemblyai-stt-3-7-realtime-agent',
    ] as const;

    for (const speechModel of models) {
      expect(
        () =>
          new STT({
            apiKey: 'test-key',
            speechModel,
            voiceFocus: 'far-field',
            mode: 'min_latency',
            languageCodes: ['en', 'es'],
          }),
      ).not.toThrow();
    }
  });

  it('enables chat context by default for every u3-pro family model', () => {
    const models = [
      'u3-rt-pro',
      'u3-rt-pro-beta-1',
      'universal-3-5-pro',
      'universal-3-6-pro',
      'assemblyai-stt-3-7-realtime-agent',
      'u3-pro',
    ] as const;

    for (const speechModel of models) {
      expect(new STT({ apiKey: 'test-key', speechModel }).capabilities.chatContext).toBe(true);
    }
  });

  it('requires a u3-rt-pro model for agentContext', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          speechModel: 'universal-streaming-english',
          agentContext: 'hello',
        }),
    ).toThrow(/agentContext/);
  });

  it('requires a u3-rt-pro model for previousContextNTurns', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          speechModel: 'universal-streaming-english',
          previousContextNTurns: 5,
        }),
    ).toThrow(/previousContextNTurns/);
  });

  it('forwards inactivity timeout to the streaming query', async () => {
    const { wss, baseUrl } = await startWebSocketServer();
    let requestUrl = '';

    wss.on('connection', (_ws, req) => {
      requestUrl = req.url ?? '';
    });

    try {
      const stream = new STT({
        apiKey: 'test-key',
        baseUrl,
        inactivityTimeout: 45,
      }).stream();

      await waitUntil(() => requestUrl !== '');
      stream.close();

      const url = new URL(`ws://127.0.0.1${requestUrl}`);
      expect(url.pathname).toBe('/v3/ws');
      expect(url.searchParams.get('inactivity_timeout')).toBe('45');
    } finally {
      await closeWebSocketServer(wss);
    }
  });
});

describe('AssemblyAI manual mode streaming', () => {
  it('emits an empty final transcript', async () => {
    await withStream({ mode: 'manual' }, async (stream, _messages, socket) => {
      socket.send(JSON.stringify({ type: 'Turn', end_of_turn: true, transcript: '', words: [] }));
      const event = await stream.next();
      expect(event.value?.type).toBe(stt.SpeechEventType.FINAL_TRANSCRIPT);
      expect(event.value?.alternatives[0]?.text).toBe('');
    });
  });

  it('sends ForceEndpoint after buffered audio', async () => {
    await withStream({ mode: 'manual' }, async (stream, messages) => {
      stream.pushFrame(frame(130));
      stream.flush();
      await waitUntil(() => messages.length === 4);

      expect(messages.slice(0, 3).map((message) => durationMs(message as Buffer))).toEqual([
        50, 50, 30,
      ]);
      expect(messages[3]).toEqual(FORCE_ENDPOINT);
    });
  });

  it('sends ForceEndpoint when no audio is buffered', async () => {
    await withStream({ mode: 'manual' }, async (stream, messages) => {
      stream.pushFrame(frame(100));
      await waitUntil(() => messages.length === 2);
      stream.flush();
      await waitUntil(() => messages.length === 3);
      expect(messages[2]).toEqual(FORCE_ENDPOINT);
    });
  });

  it('holds a tail under 20ms for the next chunk', async () => {
    await withStream({ mode: 'manual' }, async (stream, messages) => {
      stream.pushFrame(frame(10, 1));
      stream.flush();
      await waitUntil(() => messages.length === 1);
      expect(messages).toEqual([FORCE_ENDPOINT]);

      stream.pushFrame(frame(40, 2));
      await waitUntil(() => messages.length === 2);
      expect(messages[1]).toEqual(
        Buffer.concat([
          Buffer.from(new Int16Array(160).fill(1).buffer),
          Buffer.from(new Int16Array(640).fill(2).buffer),
        ]),
      );
    });
  });

  it('pads a final tail under 20ms', async () => {
    await withStream({ mode: 'manual' }, async (stream, messages) => {
      stream.pushFrame(frame(10));
      stream.endInput();
      await waitUntil(() => messages.some((message) => !(message instanceof Buffer)));

      const audio = messages.filter((message): message is Buffer => message instanceof Buffer);
      expect(audio).toHaveLength(1);
      expect(audio[0]).toEqual(
        Buffer.concat([Buffer.from(new Int16Array(160).fill(1).buffer), Buffer.alloc(320)]),
      );
    });
  });

  it('does not end the turn on a flush outside manual mode', async () => {
    await withStream({ mode: 'balanced' }, async (stream, messages) => {
      stream.pushFrame(frame(130));
      stream.flush();
      stream.pushFrame(frame(50));
      await waitUntil(() => messages.length === 4);
      expect(messages.every((message) => message instanceof Buffer)).toBe(true);
    });
  });

  it('terminates manual input without ForceEndpoint', async () => {
    await withStream({ mode: 'manual' }, async (stream, messages) => {
      stream.pushFrame(frame(130));
      stream.endInput();
      await waitUntil(() => messages.some((message) => !(message instanceof Buffer)));

      expect(messages).not.toContainEqual(FORCE_ENDPOINT);
      expect(
        messages.filter((message): message is Buffer => message instanceof Buffer).map(durationMs),
      ).toEqual([50, 50, 30]);
    });
  });
});

const hasAssemblyAIApiKey = Boolean(process.env.ASSEMBLYAI_API_KEY);

if (hasAssemblyAIApiKey) {
  describe('AssemblyAI', async () => {
    await runSTTTests(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('AssemblyAI', () => {
    it.skip('requires ASSEMBLYAI_API_KEY', () => {});
  });
}
