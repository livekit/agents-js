// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as genai from '@google/genai';
import type { LiveServerContent } from '@google/genai';
import { Behavior, FunctionResponseScheduling } from '@google/genai';
import { llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { historyConfigForSetup } from './live_setup.js';
import { RealtimeModel, RealtimeSession } from './realtime_api.js';

type ServerCallbacks = {
  onopen: () => void;
  onmessage: (message: genai.LiveServerMessage) => void;
};

type FakeLiveSession = {
  sent: Array<['content' | 'tool_response', unknown]>;
  sendClientContent: (params: { turns: unknown; turnComplete: boolean }) => void | Promise<void>;
  sendToolResponse: (params: { functionResponses: unknown }) => void | Promise<void>;
  sendRealtimeInput: () => void;
  close: () => void;
};

const fakeLive = vi.hoisted(() => ({
  callbacks: [] as ServerCallbacks[],
  connectGate: Promise.resolve(),
  sockets: [] as FakeLiveSession[],
}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof genai>();
  return {
    ...actual,
    GoogleGenAI: class {
      live = {
        connect: async ({ callbacks }: { callbacks: ServerCallbacks }) => {
          await fakeLive.connectGate;
          const socket = fakeLive.sockets[fakeLive.callbacks.length];
          if (!socket) throw new Error('no fake Gemini Live socket configured');
          fakeLive.callbacks.push(callbacks);
          callbacks.onopen();
          return socket;
        },
      };
    },
  };
});

type ToolCallStatus = {
  name: string;
  status: 'pending' | 'continuing' | 'completed' | 'cancelled';
  willContinueSent: boolean;
  createdAt: number;
};

type RealtimeSessionInternals = {
  options: {
    toolBehavior?: Behavior;
    toolResponseScheduling?: FunctionResponseScheduling;
    vertexai?: boolean;
  };
  currentGeneration?: {
    functionChannel: {
      closed: boolean;
      write: ReturnType<typeof vi.fn>;
    };
  };
  pendingToolCallIds: Set<string>;
  toolCallStatuses: Map<string, ToolCallStatus>;
  toolResponseCallIds: WeakMap<Record<string, unknown>, string>;
  sendClientEvent: ReturnType<typeof vi.fn>;
  markCurrentGenerationDone: ReturnType<typeof vi.fn>;
  getToolResultsForRealtime(
    ctx: llm.ChatContext,
    vertexai: boolean,
  ): { functionResponses: Array<Record<string, unknown>> } | undefined;
  handleToolCall(toolCall: {
    functionCalls?: Array<{
      id?: string;
      name?: string;
      args?: Record<string, unknown>;
    }>;
  }): void;
  clearPendingToolCallIdsForResponses(functionResponses: Array<Record<string, unknown>>): void;
};

const schedulingModes = [
  FunctionResponseScheduling.SILENT,
  FunctionResponseScheduling.WHEN_IDLE,
  FunctionResponseScheduling.INTERRUPT,
];

function createSessionForTest(
  toolResponseScheduling: FunctionResponseScheduling,
): RealtimeSessionInternals {
  const session = Object.create(RealtimeSession.prototype) as RealtimeSessionInternals;
  session.options = {
    toolBehavior: Behavior.NON_BLOCKING,
    toolResponseScheduling,
    vertexai: false,
  };
  session.pendingToolCallIds = new Set();
  session.toolCallStatuses = new Map();
  session.toolResponseCallIds = new WeakMap();
  session.sendClientEvent = vi.fn();
  session.markCurrentGenerationDone = vi.fn();
  session.currentGeneration = {
    functionChannel: {
      closed: false,
      write: vi.fn(),
    },
  };
  return session;
}

describe('Google Realtime non-blocking tool scheduling', () => {
  it.each(schedulingModes)(
    'sends %s on the immediate willContinue response',
    (toolResponseScheduling) => {
      const session = createSessionForTest(toolResponseScheduling);

      session.handleToolCall({
        functionCalls: [
          {
            id: 'call_123',
            name: 'getWeather',
            args: { location: 'Seattle' },
          },
        ],
      });

      expect(session.sendClientEvent).toHaveBeenCalledWith({
        type: 'tool_response',
        value: {
          functionResponses: [
            {
              id: 'call_123',
              name: 'getWeather',
              response: {},
              scheduling: toolResponseScheduling,
              willContinue: true,
            },
          ],
        },
      });
      expect(session.toolCallStatuses.get('call_123')).toMatchObject({
        name: 'getWeather',
        status: 'continuing',
        willContinueSent: true,
      });
      expect(session.pendingToolCallIds.has('call_123')).toBe(true);
    },
  );

  it.each(schedulingModes)(
    'sends %s on the final non-blocking tool response',
    (toolResponseScheduling) => {
      const session = createSessionForTest(toolResponseScheduling);
      session.toolCallStatuses.set('call_123', {
        name: 'getWeather',
        status: 'continuing',
        willContinueSent: true,
        createdAt: Date.now(),
      });

      const ctx = llm.ChatContext.empty();
      ctx.insert(
        llm.FunctionCallOutput.create({
          callId: 'call_123',
          name: 'getWeather',
          output: 'The weather in Seattle is sunny today.',
          isError: false,
        }),
      );

      const result = session.getToolResultsForRealtime(ctx, false);

      expect(result?.functionResponses).toEqual([
        {
          id: 'call_123',
          name: 'getWeather',
          response: { output: 'The weather in Seattle is sunny today.' },
          scheduling: toolResponseScheduling,
          willContinue: false,
        },
      ]);
      expect(session.toolCallStatuses.get('call_123')).toMatchObject({
        status: 'completed',
        willContinueSent: true,
      });
    },
  );

  it('clears pending tool calls for VertexAI responses without ids', () => {
    const session = createSessionForTest(FunctionResponseScheduling.WHEN_IDLE);
    session.pendingToolCallIds.add('call_123');

    const ctx = llm.ChatContext.empty();
    ctx.insert(
      llm.FunctionCallOutput.create({
        callId: 'call_123',
        name: 'getWeather',
        output: 'The weather in Seattle is sunny today.',
        isError: false,
      }),
    );

    const result = session.getToolResultsForRealtime(ctx, true);

    expect(result?.functionResponses).toEqual([
      {
        name: 'getWeather',
        response: { output: 'The weather in Seattle is sunny today.' },
        scheduling: FunctionResponseScheduling.WHEN_IDLE,
      },
    ]);

    session.clearPendingToolCallIdsForResponses(result?.functionResponses ?? []);

    expect(session.pendingToolCallIds.has('call_123')).toBe(false);
  });
});

type ServerContentSessionInternals = {
  _realtimeModel: { capabilities: { audioOutput: boolean } };
  options: { outputAudioTranscription?: Record<string, never> };
  earlyCompletionPending: boolean;
  currentGeneration: {
    outputText: string;
    textChannel: { write: ReturnType<typeof vi.fn> };
  };
  handleServerContent(serverContent: LiveServerContent): void;
};

function createServerContentSession({
  audioOutput,
  outputAudioTranscription,
}: {
  audioOutput: boolean;
  outputAudioTranscription?: Record<string, never>;
}): ServerContentSessionInternals {
  const session = Object.create(RealtimeSession.prototype) as ServerContentSessionInternals;
  session._realtimeModel = { capabilities: { audioOutput } };
  session.options = { outputAudioTranscription };
  session.earlyCompletionPending = false;
  session.currentGeneration = {
    outputText: '',
    textChannel: { write: vi.fn() },
  };
  return session;
}

describe('Google Realtime model text parts', () => {
  const modelTextTurn: LiveServerContent = {
    modelTurn: { parts: [{ text: 'call:getWeather{location:Seattle' }] },
    outputTranscription: { text: 'Let me check.' },
  };

  it('keeps unspoken model text out of the transcript in an audio session', () => {
    const session = createServerContentSession({
      audioOutput: true,
      outputAudioTranscription: {},
    });

    session.handleServerContent(modelTextTurn);

    expect(session.currentGeneration.textChannel.write.mock.calls).toEqual([['Let me check.']]);
    expect(session.currentGeneration.outputText).toBe('Let me check.');
  });

  it('forwards model text when the session runs in text modality', () => {
    const session = createServerContentSession({
      audioOutput: false,
      outputAudioTranscription: {},
    });

    session.handleServerContent({ modelTurn: { parts: [{ text: 'Hello there.' }] } });

    expect(session.currentGeneration.textChannel.write.mock.calls).toEqual([['Hello there.']]);
    expect(session.currentGeneration.outputText).toBe('Hello there.');
  });

  it('forwards model text when output transcription is disabled', () => {
    const session = createServerContentSession({ audioOutput: true });

    session.handleServerContent({ modelTurn: { parts: [{ text: 'Hello there.' }] } });

    expect(session.currentGeneration.textChannel.write.mock.calls).toEqual([['Hello there.']]);
    expect(session.currentGeneration.outputText).toBe('Hello there.');
  });
});

describe('Google Realtime initial history seeding', () => {
  function historyConfigFor(model: string) {
    const { capabilities } = new RealtimeModel({ model, apiKey: 'test-key' });
    return historyConfigForSetup({ mutableChatCtx: capabilities.midSessionChatCtxUpdate ?? true });
  }

  it('asks the server to treat the prefill as history on models that reject one', () => {
    expect(historyConfigFor('gemini-3.1-flash-live-preview')).toEqual({
      initialHistoryInClientContent: true,
    });
  });

  it('leaves models that accept a plain prefill alone', () => {
    expect(historyConfigFor('gemini-2.0-flash-live-001')).toBeUndefined();
  });
});

type ResumptionSessionInternals = {
  activeSession?: FakeLiveSession;
  _chatCtx: llm.ChatContext;
  sessionResumptionHandle?: string;
  resumptionChatCtx?: llm.ChatContext;
  pendingChatCtx?: llm.ChatContext;
  unsentItemIds: Set<string>;
};

function newFakeSession(overrides: Partial<Omit<FakeLiveSession, 'sent'>> = {}): FakeLiveSession {
  const sent: FakeLiveSession['sent'] = [];
  return {
    sent,
    sendClientContent: ({ turns }) => {
      sent.push(['content', turns]);
    },
    sendToolResponse: ({ functionResponses }) => {
      sent.push(['tool_response', functionResponses]);
    },
    sendRealtimeInput: () => {},
    close: () => {},
    ...overrides,
  };
}

async function connectedSession({
  handle,
  known,
  sentAfterHandle,
  pending,
  callerHandle = false,
}: {
  handle?: string;
  known?: llm.ChatContext;
  sentAfterHandle?: llm.ChatContext;
  pending?: llm.ChatContext;
  callerHandle?: boolean;
}): Promise<{ session: RealtimeSession; fake: FakeLiveSession }> {
  fakeLive.callbacks.length = 0;
  let openConnection = () => {};
  fakeLive.connectGate = new Promise<void>((resolve) => (openConnection = resolve));
  const fake = newFakeSession();
  fakeLive.sockets = [fake];

  const session = new RealtimeModel({
    apiKey: 'fake-key',
    sessionResumption: callerHandle ? { handle } : undefined,
  }).session();
  const internals = session as unknown as ResumptionSessionInternals;
  if (!callerHandle) internals.sessionResumptionHandle = handle;
  if (known) {
    internals.resumptionChatCtx = known;
    internals._chatCtx = sentAfterHandle ?? known;
  }
  if (pending) await session.updateChatCtx(pending);

  openConnection();
  await vi.waitFor(() => expect(internals.activeSession).toBe(fake));
  await vi.waitFor(() => expect(internals.unsentItemIds.size).toBe(0));
  return { session, fake };
}

function sentTexts(sent: FakeLiveSession['sent']): string[][] {
  return sent
    .filter((entry): entry is ['content', genai.Content[]] => entry[0] === 'content')
    .map(([, turns]) => turns.flatMap((turn) => (turn.parts ?? []).map((part) => part.text ?? '')));
}

describe('Google Realtime session resumption context', () => {
  it('replays the chat context on a fresh session', async () => {
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'hello' });
    ctx.addMessage({ role: 'assistant', content: 'hi' });

    const { session, fake } = await connectedSession({ pending: ctx });
    try {
      expect(sentTexts(fake.sent)).toEqual([['hello', 'hi']]);
      expect((session as unknown as ResumptionSessionInternals).pendingChatCtx).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('skips chat context replay on a resumed session', async () => {
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'hello' });

    const { session, fake } = await connectedSession({
      handle: 'resume-1',
      known: ctx,
      pending: ctx,
    });
    try {
      expect(fake.sent).toEqual([]);
      expect((session as unknown as ResumptionSessionInternals).pendingChatCtx).toBeUndefined();
      expect(
        session.chatCtx.items.map((item) => item.type === 'message' && item.rawTextContent),
      ).toEqual(['hello']);
    } finally {
      await session.close();
    }
  });

  it('sends only the disconnected update on a resumed session', async () => {
    const known = llm.ChatContext.empty();
    known.addMessage({ role: 'user', content: 'hello' });
    const updated = known.copy();
    updated.addMessage({ role: 'user', content: 'one more thing' });

    const { session, fake } = await connectedSession({
      handle: 'resume-1',
      known,
      pending: updated,
    });
    try {
      expect(sentTexts(fake.sent)).toEqual([['one more thing']]);
      expect(
        session.chatCtx.items.map((item) => item.type === 'message' && item.rawTextContent),
      ).toEqual(['hello', 'one more thing']);
    } finally {
      await session.close();
    }
  });

  it('delivers the tool result produced during a restart', async () => {
    const known = llm.ChatContext.empty();
    known.addMessage({ role: 'user', content: 'book it' });
    known.items.push(llm.FunctionCall.create({ callId: 'call-1', name: 'book', args: '{}' }));
    const updated = known.copy();
    updated.items.push(
      llm.FunctionCallOutput.create({
        callId: 'call-1',
        name: 'book',
        output: 'done',
        isError: false,
      }),
    );

    const { session, fake } = await connectedSession({
      handle: 'resume-1',
      known,
      pending: updated,
    });
    try {
      expect(fake.sent.map(([kind]) => kind)).toEqual(['tool_response']);
      expect(fake.sent[0]![1]).toMatchObject([{ id: 'call-1' }]);
    } finally {
      await session.close();
    }
  });

  it('resends context that arrived after the last handle', async () => {
    const known = llm.ChatContext.empty();
    known.addMessage({ role: 'user', content: 'hello' });
    const later = known.copy();
    later.addMessage({ role: 'user', content: 'sent before the socket dropped' });

    const { session, fake } = await connectedSession({
      handle: 'resume-1',
      known,
      sentAfterHandle: later,
    });
    try {
      expect(sentTexts(fake.sent)).toEqual([['sent before the socket dropped']]);
      expect((session as unknown as ResumptionSessionInternals).pendingChatCtx).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('adopts history without replay for a caller-provided handle', async () => {
    const history = llm.ChatContext.empty();
    history.addMessage({ role: 'user', content: 'from the previous process' });
    history.addMessage({ role: 'assistant', content: 'noted' });

    const { session, fake } = await connectedSession({
      handle: 'resume-1',
      pending: history,
      callerHandle: true,
    });
    try {
      expect(fake.sent).toEqual([]);
      expect(
        session.chatCtx.items.map((item) => item.type === 'message' && item.rawTextContent),
      ).toEqual(['from the previous process', 'noted']);
    } finally {
      await session.close();
    }
  });

  it('does not let a handle claim a queued but unsent update', async () => {
    const known = llm.ChatContext.empty();
    known.addMessage({ role: 'user', content: 'hello' });
    const updated = known.copy();
    updated.addMessage({ role: 'user', content: 'queued behind the handle' });

    let releaseSend = () => {};
    const sendGate = new Promise<void>((resolve) => (releaseSend = resolve));
    const first = newFakeSession({
      sendClientContent: async () => {
        await sendGate;
      },
    });
    const second = newFakeSession();
    fakeLive.callbacks.length = 0;
    fakeLive.connectGate = Promise.resolve();
    fakeLive.sockets = [first, second];

    const session = new RealtimeModel({ apiKey: 'fake-key' }).session();
    const internals = session as unknown as ResumptionSessionInternals;
    internals.sessionResumptionHandle = 'resume-1';
    internals.resumptionChatCtx = known;
    internals._chatCtx = known;
    await session.updateChatCtx(updated);
    try {
      await vi.waitFor(() => expect(internals.unsentItemIds.size).toBe(1));
      fakeLive.callbacks[0]!.onmessage({
        sessionResumptionUpdate: { newHandle: 'resume-2', resumable: true },
      } as genai.LiveServerMessage);
      await vi.waitFor(() =>
        expect(internals.resumptionChatCtx?.items.map((item) => item.id)).toEqual(
          known.items.map((item) => item.id),
        ),
      );

      await session.updateTools(
        new llm.ToolContext([
          llm.tool({
            name: 'restart_tool',
            description: 'restart the socket',
            execute: async () => '',
          }),
        ]),
      );
      await vi.waitFor(() => expect(fakeLive.callbacks).toHaveLength(2), { timeout: 3000 });
      await vi.waitFor(() =>
        expect(sentTexts(second.sent)).toEqual([['queued behind the handle']]),
      );
    } finally {
      releaseSend();
      await session.close();
    }
  });

  it('replays every queued item once after a failed send', async () => {
    const known = llm.ChatContext.empty();
    known.addMessage({ role: 'user', content: 'hello' });
    const firstUpdate = known.copy();
    firstUpdate.addMessage({ role: 'user', content: 'first update' });

    let sendStarted = () => {};
    const started = new Promise<void>((resolve) => (sendStarted = resolve));
    let releaseSend = () => {};
    const sendGate = new Promise<void>((resolve) => (releaseSend = resolve));
    const first = newFakeSession({
      sendClientContent: async () => {
        sendStarted();
        await sendGate;
        throw new Error('socket gone');
      },
    });
    const second = newFakeSession();
    fakeLive.callbacks.length = 0;
    fakeLive.connectGate = Promise.resolve();
    fakeLive.sockets = [first, second];

    const session = new RealtimeModel({ apiKey: 'fake-key' }).session();
    const internals = session as unknown as ResumptionSessionInternals;
    internals.sessionResumptionHandle = 'resume-1';
    internals.resumptionChatCtx = known;
    internals._chatCtx = known;
    await session.updateChatCtx(firstUpdate);
    try {
      await started;
      const secondUpdate = firstUpdate.copy();
      secondUpdate.addMessage({ role: 'user', content: 'second update' });
      await session.updateChatCtx(secondUpdate);
      releaseSend();

      await vi.waitFor(() => expect(fakeLive.callbacks).toHaveLength(2), { timeout: 3000 });
      await vi.waitFor(() =>
        expect(sentTexts(second.sent)).toEqual([['first update', 'second update']]),
      );
      expect(first.sent).toEqual([]);
      expect(internals.unsentItemIds.size).toBe(0);
    } finally {
      releaseSend();
      await session.close();
    }
  });
});
