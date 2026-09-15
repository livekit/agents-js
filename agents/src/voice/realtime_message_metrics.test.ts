// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { type JobContext, runWithJobContextAsync } from '../job.js';
import { ChatContext, type FunctionCall } from '../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type MessageGeneration,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import { type ToolChoice, ToolContext } from '../llm/tool_context.js';
import { initializeLogger, log } from '../log.js';
import type { RealtimeModelMetrics } from '../metrics/base.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type ConversationItemAddedEvent } from './events.js';

initializeLogger({ pretty: false, level: 'silent' });

function emptyStream<T>(): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      controller.close();
    },
  });
}

function oneItemStream<T>(item: T): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      controller.enqueue(item);
      controller.close();
    },
  });
}

class FakeRealtimeSession extends RealtimeSession {
  closingMetrics?: RealtimeModelMetrics;
  private _chatCtx = ChatContext.empty();
  private _tools = ToolContext.empty();

  get chatCtx(): ChatContext {
    return this._chatCtx;
  }

  get tools(): ToolContext {
    return this._tools;
  }

  async updateInstructions(_instructions: string): Promise<void> {}

  async updateChatCtx(chatCtx: ChatContext): Promise<void> {
    this._chatCtx = chatCtx.copy();
  }

  async updateTools(tools: ToolContext): Promise<void> {
    this._tools = tools.copy();
  }

  updateOptions(_options: { toolChoice?: ToolChoice | null }): void {}

  pushAudio(_frame: AudioFrame): void {}

  async generateReply(): Promise<GenerationCreatedEvent> {
    const message: MessageGeneration = {
      messageId: 'message-id',
      textStream: oneItemStream('Hello'),
      audioStream: emptyStream(),
      modalities: Promise.resolve(['text']),
    };

    return {
      messageStream: oneItemStream(message),
      functionStream: emptyStream<FunctionCall>(),
      userInitiated: true,
      responseId: 'provider-response-id',
    };
  }

  async commitAudio(): Promise<void> {}

  async clearAudio(): Promise<void> {}

  async interrupt(): Promise<void> {}

  async truncate(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closingMetrics) this.emit('metrics_collected', this.closingMetrics);
    await super.close();
  }
}

class FakeRealtimeModel extends RealtimeModel {
  readonly activeSession: FakeRealtimeSession;

  constructor(turnDetection = false) {
    const capabilities: RealtimeCapabilities = {
      messageTruncation: false,
      turnDetection,
      userTranscription: false,
      autoToolReplyGeneration: false,
      audioOutput: false,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: true,
      midSessionInstructionsUpdate: true,
      midSessionToolsUpdate: true,
      perResponseToolChoice: false,
    };
    super(capabilities);
    this.activeSession = new FakeRealtimeSession(this);
  }

  get model(): string {
    return 'fake-realtime';
  }

  session(): RealtimeSession {
    return this.activeSession;
  }

  async close(): Promise<void> {}
}

const REALTIME_REDACTION_WARNING =
  'RealtimeModel user turns lack complete speech timestamps, so audio redaction may be inaccurate; disable audio recording to prevent redaction leak.';

function fakeJobContext(enableRedaction: boolean): JobContext {
  return {
    job: { enableRecording: true, enableRedaction },
    simulationContext: () => undefined,
    initRecording: vi.fn(async () => {}),
    _primaryAgentSession: undefined,
    sessionDirectory: undefined,
  } as unknown as JobContext;
}

async function runRealtimeSession({
  projectRedaction,
  sessionRedaction,
  stt,
  serverTurnDetection = true,
}: {
  projectRedaction: boolean;
  sessionRedaction: boolean;
  stt?: FakeSTT;
  serverTurnDetection?: boolean;
}): Promise<void> {
  const session = new AgentSession({
    llm: new FakeRealtimeModel(serverTurnDetection),
    stt,
    vad: null,
    turnHandling: { turnDetection: null },
  });

  await runWithJobContextAsync(fakeJobContext(projectRedaction), async () => {
    await session.start({
      agent: new Agent({ instructions: 'test' }),
      record: sessionRedaction ? { redaction: true } : true,
    });
    await session.close();
  });
}

describe('Realtime message metrics', () => {
  it('collects usage reported while the provider session closes', async () => {
    const model = new FakeRealtimeModel();
    const session = new AgentSession({
      llm: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });
    await session.start({ agent: new Agent({ instructions: 'test' }) });
    model.activeSession.closingMetrics = {
      type: 'realtime_model_metrics',
      label: 'fake',
      requestId: 'sess_1',
      timestamp: Date.now(),
      durationMs: 0,
      ttftMs: -1,
      cancelled: false,
      tokensPerSecond: 0,
      sessionDurationMs: 12_500,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: { audioTokens: 90, textTokens: 10, imageTokens: 0, cachedTokens: 0 },
      outputTokenDetails: { audioTokens: 40, textTokens: 10, imageTokens: 0 },
      metadata: { modelName: 'fake-live', modelProvider: 'fake.provider' },
    };
    await session.close();
    expect(session.usage.modelUsage).toContainEqual(
      expect.objectContaining({
        provider: 'fake.provider',
        inputTokens: 100,
        inputAudioTokens: 90,
        outputTokens: 50,
        outputAudioTokens: 40,
        sessionDurationMs: 12_500,
      }),
    );
    expect(model.activeSession.listenerCount('metrics_collected')).toBe(0);
  });

  it('makes realtime response IDs available on assistant messages', async () => {
    const llm = new FakeRealtimeModel();
    const session = new AgentSession({ llm, vad: null, turnHandling: { turnDetection: null } });
    const conversationEvents: ConversationItemAddedEvent[] = [];

    session.on(AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      conversationEvents.push(ev);
    });

    await session.start({ agent: new Agent({ instructions: 'test' }) });
    try {
      await session.generateReply().waitForPlayout();
    } finally {
      await session.close();
    }

    const assistantMessages = conversationEvents
      .map((event) => event.item)
      .filter((item) => item.type === 'message' && item.role === 'assistant');

    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.metrics.providerRequestIds).toEqual(['provider-response-id']);
  });
});

describe('Realtime audio redaction warning', () => {
  it.each([
    { source: 'project', projectRedaction: true, sessionRedaction: false },
    { source: 'session', projectRedaction: false, sessionRedaction: true },
  ])('warns when $source redaction is enabled', async (options) => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);

    try {
      await runRealtimeSession(options);
      expect(warn).toHaveBeenCalledWith(REALTIME_REDACTION_WARNING);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when STT is configured', async () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);

    try {
      await runRealtimeSession({
        projectRedaction: true,
        sessionRedaction: false,
        stt: new FakeSTT(),
      });
      expect(warn).toHaveBeenCalledWith(REALTIME_REDACTION_WARNING);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when server-side turn detection is disabled', async () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);

    try {
      await runRealtimeSession({
        projectRedaction: true,
        sessionRedaction: false,
        serverTurnDetection: false,
      });
      expect(warn).toHaveBeenCalledWith(REALTIME_REDACTION_WARNING);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when redaction is disabled', async () => {
    const warn = vi.spyOn(log(), 'warn').mockImplementation(() => undefined);

    try {
      await runRealtimeSession({
        projectRedaction: false,
        sessionRedaction: false,
      });
      expect(warn).not.toHaveBeenCalledWith(REALTIME_REDACTION_WARNING);
    } finally {
      warn.mockRestore();
    }
  });
});
