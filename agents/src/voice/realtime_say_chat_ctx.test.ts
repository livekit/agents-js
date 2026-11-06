// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext, type FunctionCall } from '../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import { type ToolChoice, ToolContext } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { Future } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';

initializeLogger({ pretty: false, level: 'silent' });

class FakeRealtimeSession extends RealtimeSession {
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
    return {
      messageStream: new ReadableStream({ start: (controller) => controller.close() }),
      functionStream: new ReadableStream<FunctionCall>({
        start: (controller) => controller.close(),
      }),
      userInitiated: true,
    };
  }

  async commitAudio(): Promise<void> {}

  async clearAudio(): Promise<void> {}

  async interrupt(): Promise<void> {}

  async truncate(): Promise<void> {}
}

class FakeRealtimeModel extends RealtimeModel {
  readonly activeSession = new FakeRealtimeSession(this);

  constructor(mutableChatContext = true) {
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: false,
      audioOutput: false,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: mutableChatContext,
    } satisfies RealtimeCapabilities);
  }

  get model(): string {
    return 'fake-realtime';
  }

  session(): RealtimeSession {
    return this.activeSession;
  }

  async close(): Promise<void> {}
}

describe('Realtime say chat context', () => {
  it.each([true, false])(
    'adds spoken messages when mutable chat context is %s',
    async (mutableChatContext) => {
      const model = new FakeRealtimeModel(mutableChatContext);
      const agent = new Agent({ instructions: 'test' });
      const session = new AgentSession({
        llm: model,
        vad: null,
        turnHandling: { turnDetection: null },
      });

      await session.start({ agent });
      try {
        await session.say('Thanks for joining! Are you ready?').waitForPlayout();

        const localMessages = agent.chatCtx.items.filter((item) => item.type === 'message');
        const remoteMessages = model.activeSession.chatCtx.items.filter(
          (item) => item.type === 'message',
        );

        expect(localMessages.map((message) => message.textContent)).toEqual([
          'Thanks for joining! Are you ready?',
        ]);
        if (mutableChatContext) {
          expect(remoteMessages.map((message) => message.id)).toEqual([localMessages[0]!.id]);
        } else {
          expect(remoteMessages).toEqual([]);
        }
      } finally {
        await session.close();
      }
    },
  );

  it('lets the next speech start while the chat context update is pending', async () => {
    const model = new FakeRealtimeModel();
    const agent = new Agent({ instructions: 'test' });
    const session = new AgentSession({
      llm: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });

    await session.start({ agent });
    const releaseUpdate = new Future<void>();
    const applyUpdate = model.activeSession.updateChatCtx.bind(model.activeSession);
    model.activeSession.updateChatCtx = vi.fn(async (chatCtx: ChatContext) => {
      await releaseUpdate.await;
      await applyUpdate(chatCtx);
    });

    try {
      const first = session.say('first');
      const second = session.say('second');

      await vi.waitFor(() => {
        expect(
          agent.chatCtx.items.some(
            (item) => item.type === 'message' && item.textContent === 'second',
          ),
        ).toBe(true);
      });
      expect(first.done()).toBe(false);

      releaseUpdate.resolve();
      await first.waitForPlayout();
      await second.waitForPlayout();
    } finally {
      releaseUpdate.resolve();
      await session.close();
    }
  });

  it('places the spoken message before later remote items', async () => {
    const model = new FakeRealtimeModel();
    const agent = new Agent({ instructions: 'test' });
    const session = new AgentSession({
      llm: model,
      vad: null,
      turnHandling: { turnDetection: null },
    });

    await session.start({ agent });
    try {
      const remoteCtx = model.activeSession.chatCtx.copy();
      const userMessage = remoteCtx.addMessage({
        role: 'user',
        content: 'yes',
        createdAt: Date.now() + 60_000,
      });
      await model.activeSession.updateChatCtx(remoteCtx);

      await session.say('Are you ready?').waitForPlayout();

      const remoteIds = model.activeSession.chatCtx.items
        .filter((item) => item.type === 'message')
        .map((item) => item.id);
      const spoken = agent.chatCtx.items.find(
        (item) => item.type === 'message' && item.textContent === 'Are you ready?',
      );

      expect(remoteIds).toEqual([spoken!.id, userMessage.id]);
    } finally {
      await session.close();
    }
  });
});
