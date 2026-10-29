// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { LiveCallbacks, LiveServerMessage, Session } from '@google/genai';
import { Behavior, Live } from '@google/genai';
import { initializeLogger, llm, voice } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RealtimeModel, type RealtimeSession } from './realtime_api.js';

initializeLogger({ pretty: false, level: 'silent' });

type Events = {
  generations: number;
  speechStarts: number;
  finals: llm.InputTranscriptionCompleted[];
};

/**
 * A session on a server that confirms every setup, with the server's messages
 * delivered by `receive` and the session's events counted.
 */
async function openSession(toolBehavior?: Behavior): Promise<{
  session: RealtimeSession;
  receive: (message: LiveServerMessage) => void;
  sendToolResponse: ReturnType<typeof vi.fn>;
  events: Events;
}> {
  let callbacks: LiveCallbacks | undefined;
  const sendToolResponse = vi.fn();
  vi.spyOn(Live.prototype, 'connect').mockImplementation(
    async (params: { callbacks: LiveCallbacks }) => {
      callbacks = params.callbacks;
      callbacks.onopen?.();
      return {
        sendClientContent: () => {},
        sendRealtimeInput: () => {},
        sendToolResponse,
        close: () => {},
      } as unknown as Session;
    },
  );
  const session = new RealtimeModel({
    model: 'gemini-3.8-live',
    apiKey: 'fake-key',
    toolBehavior,
  }).session();
  const events: Events = { generations: 0, speechStarts: 0, finals: [] };
  session.on('generation_created', () => events.generations++);
  session.on('input_speech_started', () => events.speechStarts++);
  session.on('input_audio_transcription_completed', (ev: llm.InputTranscriptionCompleted) => {
    if (ev.isFinal) events.finals.push(ev);
  });
  // Messages that arrive before the session holds the connection are dropped.
  await vi.waitFor(() =>
    expect((session as unknown as { activeSession?: Session }).activeSession).toBeDefined(),
  );
  return {
    session,
    receive: (message) => callbacks!.onmessage(message),
    sendToolResponse,
    events,
  };
}

const toolCall = (): LiveServerMessage =>
  ({
    toolCall: { functionCalls: [{ id: 'call_1', name: 'getCurriculum', args: {} }] },
  }) as LiveServerMessage;

// Gemini can deliver the transcript of the turn that made a tool call after the call itself.
const lateTranscript = (): LiveServerMessage =>
  ({
    serverContent: { inputTranscription: { text: 'What do I need to know for my exam?' } },
  }) as LiveServerMessage;

/**
 * The tool result the agent sends back once the tool has run.
 */
function toolOutput(session: RealtimeSession): llm.ChatContext {
  const ctx = session.chatCtx.copy();
  ctx.insert(
    llm.FunctionCallOutput.create({
      callId: 'call_1',
      name: 'getCurriculum',
      output: 'Functions, limits, derivatives.',
      isError: false,
    }),
  );
  return ctx;
}

describe('Google Realtime input transcription during a blocking tool call', () => {
  let session: RealtimeSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.restoreAllMocks();
  });

  it('holds it instead of starting a generation, and hands it over with the tool result', async () => {
    const opened = await openSession();
    session = opened.session;

    opened.receive(toolCall());
    await vi.waitFor(() => expect(opened.events.generations).toBe(1));
    opened.receive(lateTranscript());
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A generation for the transcript would interrupt the tool call's turn, and the agent waits
    // for it to play before sending the tool result: it never plays.
    expect(opened.events.generations).toBe(1);
    expect(opened.events.speechStarts).toBe(1);
    expect(opened.events.finals).toEqual([]);

    await session.updateChatCtx(toolOutput(session));
    await vi.waitFor(() => expect(opened.sendToolResponse).toHaveBeenCalledTimes(1));

    await vi.waitFor(() => expect(opened.events.finals).toHaveLength(1));
    const [final] = opened.events.finals;
    expect(final).toMatchObject({ transcript: 'What do I need to know for my exam?' });
    expect(final!.turnStartedAt).toBeTypeOf('number');

    // The turn began before the tool call, so it sorts ahead of the tool result.
    const items = session.chatCtx.items;
    const userIndex = items.findIndex((item) => item.id === final!.itemId);
    const outputIndex = items.findIndex((item) => item.type === 'function_call_output');
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeLessThan(outputIndex);
  });

  it('keeps the turn out of the next chat context update', async () => {
    const opened = await openSession();
    session = opened.session;
    opened.receive(toolCall());
    await vi.waitFor(() => expect(opened.events.generations).toBe(1));
    opened.receive(lateTranscript());
    await session.updateChatCtx(toolOutput(session));
    await vi.waitFor(() => expect(opened.events.finals).toHaveLength(1));

    // The agent files the turn by when it began, next to the call it recorded when the tool
    // started; an update from that context must not send the turn to Gemini again.
    const [final] = opened.events.finals;
    const agentCtx = session.chatCtx.copy();
    agentCtx.insert(
      llm.FunctionCall.create({
        callId: 'call_1',
        name: 'getCurriculum',
        args: '{}',
        createdAt: final!.turnStartedAt! + 1,
      }),
    );
    const diff = llm.computeChatCtxDiff(session.chatCtx, agentCtx);

    expect(diff.toCreate.map(([, id]) => id)).not.toContain(final!.itemId);
  });

  it('hands it over when the call is cancelled, and only once', async () => {
    const opened = await openSession();
    session = opened.session;
    opened.receive(toolCall());
    await vi.waitFor(() => expect(opened.events.generations).toBe(1));
    opened.receive(lateTranscript());
    opened.receive({ toolCallCancellation: { ids: ['call_1'] } } as LiveServerMessage);

    await vi.waitFor(() => expect(opened.events.finals).toHaveLength(1));

    opened.receive({
      serverContent: { outputTranscription: { text: 'Sure.' } },
    } as LiveServerMessage);
    await vi.waitFor(() => expect(opened.events.generations).toBe(2));
    expect(opened.events.finals).toHaveLength(1);
  });

  it('starts a generation for it when no tool call is pending', async () => {
    const opened = await openSession();
    session = opened.session;

    opened.receive(lateTranscript());

    await vi.waitFor(() => expect(opened.events.generations).toBe(1));
  });

  it('starts a generation for it with non-blocking tools, where it can be a new turn', async () => {
    const opened = await openSession(Behavior.NON_BLOCKING);
    session = opened.session;
    opened.receive(toolCall());
    await vi.waitFor(() => expect(opened.events.generations).toBe(1));

    opened.receive(lateTranscript());

    await vi.waitFor(() => expect(opened.events.generations).toBe(2));
  });
});

/**
 * Plays every frame at once.
 */
class InstantAudioOutput extends voice.AudioOutput {
  constructor() {
    super(24000);
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    this.onPlaybackStarted(Date.now());
  }

  override flush(): void {
    super.flush();
    this.onPlaybackFinished({ playbackPosition: 0.1, interrupted: false });
  }

  override clearBuffer(): void {
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
  }
}

describe('Google Realtime tool call followed by the turn transcript, in an AgentSession', () => {
  let session: voice.AgentSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    vi.restoreAllMocks();
  });

  it('sends the tool result and records the turn before the tool call', async () => {
    let callbacks: LiveCallbacks | undefined;
    const sendToolResponse = vi.fn();
    vi.spyOn(Live.prototype, 'connect').mockImplementation(
      async (params: { callbacks: LiveCallbacks }) => {
        callbacks = params.callbacks;
        callbacks.onopen?.();
        return {
          sendClientContent: () => {},
          sendRealtimeInput: () => {},
          sendToolResponse,
          close: () => {},
        } as unknown as Session;
      },
    );
    const model = new RealtimeModel({ model: 'gemini-3.8-live', apiKey: 'fake-key' });
    const agent = new voice.Agent({
      instructions: 'You are a tutor.',
      tools: {
        getCurriculum: llm.tool({
          description: 'Look up the curriculum.',
          parameters: z.object({}),
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return 'Functions, limits, derivatives.';
          },
        }),
      },
    });
    session = new voice.AgentSession({ llm: model });
    session.output.audio = new InstantAudioOutput();
    await session.start({ agent });

    const realtime = (session as unknown as { activity?: { realtimeLLMSession?: unknown } })
      .activity?.realtimeLLMSession as { activeSession?: Session } | undefined;
    await vi.waitFor(() => expect(realtime?.activeSession).toBeDefined());
    const receive = (message: LiveServerMessage) => callbacks!.onmessage(message);

    receive({
      toolCall: { functionCalls: [{ id: 'call_1', name: 'getCurriculum', args: {} }] },
    } as LiveServerMessage);
    // In the recorded session the turn's transcript arrived 8 ms after the call.
    await new Promise((resolve) => setTimeout(resolve, 8));
    receive({
      serverContent: { inputTranscription: { text: 'What do I need to know for my exam?' } },
    } as LiveServerMessage);

    await vi.waitFor(() => expect(sendToolResponse).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    receive({
      serverContent: {
        outputTranscription: { text: 'Functions, limits and derivatives.' },
        generationComplete: true,
        turnComplete: true,
      },
    } as LiveServerMessage);

    await vi.waitFor(
      () =>
        expect(
          session!.history.items.some(
            (item) =>
              item.type === 'message' &&
              item.role === 'assistant' &&
              item.textContent?.includes('derivatives'),
          ),
        ).toBe(true),
      { timeout: 3_000 },
    );

    const items = session.history.items;
    const userIndex = items.findIndex((item) => item.type === 'message' && item.role === 'user');
    const callIndex = items.findIndex((item) => item.type === 'function_call');
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeLessThan(callIndex);
  });
});
