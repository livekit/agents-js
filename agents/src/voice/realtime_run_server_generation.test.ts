// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { type ChatContext, FunctionCall } from '../llm/chat_context.js';
import {
  type GenerationCreatedEvent,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
} from '../llm/realtime.js';
import { type ToolChoice, ToolContext, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { Future } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';

initializeLogger({ pretty: false, level: 'silent' });

const GREETING = 'could you give me your ID number?';

function stream<T>(...items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}

function generation(
  text: string | null,
  fnc: FunctionCall | null,
  responseId: string,
): GenerationCreatedEvent {
  return {
    messageStream:
      text === null
        ? stream()
        : stream({
            messageId: `msg-${responseId}`,
            textStream: stream(text),
            audioStream: stream<AudioFrame>(),
            modalities: Promise.resolve(['text'] as ('text' | 'audio')[]),
          }),
    functionStream: fnc === null ? stream<FunctionCall>() : stream(fnc),
    userInitiated: false,
    responseId,
  };
}

/**
 * Answers the first generateReply() with a tool call and, like Gemini Live, continues on its
 * own once the tool result is pushed. The protocol carries no response ids, so the plugin hands
 * that continuation to whichever generateReply() is pending (here the handed-off agent's), and
 * the greeting itself arrives as the server's own generation.
 */
class AutoContinuingSession extends RealtimeSession {
  private _chatCtx: ChatContext | undefined;
  private _tools = ToolContext.empty();
  private replies = 0;
  private pending: Future<GenerationCreatedEvent> | undefined;

  get chatCtx(): ChatContext {
    return this._chatCtx!;
  }
  get tools(): ToolContext {
    return this._tools;
  }
  async updateInstructions(_instructions: string): Promise<void> {}
  async updateChatCtx(chatCtx: ChatContext): Promise<void> {
    const known = new Set(this._chatCtx?.items.map((item) => item.id) ?? []);
    this._chatCtx = chatCtx.copy();
    const newOutput = chatCtx.items.some(
      (item) => item.type === 'function_call_output' && !known.has(item.id),
    );
    if (newOutput) setTimeout(() => this.continueOnOwn(), 200);
  }
  async updateTools(tools: ToolContext): Promise<void> {
    this._tools = tools.copy();
  }
  updateOptions(_options: { toolChoice?: ToolChoice | null }): void {}
  pushAudio(_frame: AudioFrame): void {}
  async commitAudio(): Promise<void> {}
  async clearAudio(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async truncate(): Promise<void> {}

  private continueOnOwn(): void {
    const continuation = generation('', null, 'continuation');
    if (this.pending && !this.pending.done) {
      continuation.userInitiated = true;
      this.pending.resolve(continuation);
    } else {
      this.emit('generation_created', continuation);
    }
    setTimeout(() => this.emit('generation_created', generation(GREETING, null, 'greeting')), 200);
  }

  async generateReply(): Promise<GenerationCreatedEvent> {
    this.replies += 1;
    if (this.replies === 1) {
      const ev = generation(
        null,
        FunctionCall.create({ callId: 'c1', name: 'verify', args: '{}' }),
        'r1',
      );
      ev.userInitiated = true;
      return ev;
    }
    this.pending = new Future<GenerationCreatedEvent>();
    return this.pending.await;
  }
}

class AutoContinuingModel extends RealtimeModel {
  readonly activeSession = new AutoContinuingSession(this);

  constructor() {
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: true,
      audioOutput: false,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: true,
      midSessionInstructionsUpdate: true,
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

class IdAgent extends Agent {
  constructor() {
    super({ instructions: 'collect the id number' });
  }

  async onEnter(): Promise<void> {
    this.session.generateReply({ instructions: 'ask for the id number' });
    // onEnter is still running when the server's continuation arrives
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

class Root extends Agent {
  constructor() {
    super({
      instructions: 'root',
      tools: [
        tool({
          name: 'verify',
          description: 'Called when the user wants to verify their identity.',
          execute: async () => {
            this.session.updateAgent(new IdAgent());
          },
        }),
      ],
    });
  }
}

describe('realtime generations started by the server during a run', () => {
  it('records the handed-off agent greeting in the run', async () => {
    const session = new AgentSession({
      llm: new AutoContinuingModel(),
      vad: null,
      turnHandling: { turnDetection: null },
    });
    await session.start({ agent: new Root() });
    try {
      const result = await session.run({ userInput: 'verify me' }).wait();

      result.expect.nextEvent().isFunctionCall({ name: 'verify' });
      result.expect.nextEvent().isFunctionCallOutput();
      result.expect.nextEvent().isAgentHandoff({ newAgentType: IdAgent });
      result.expect.nextEvent().isMessage({ role: 'assistant' });
      expect(
        session.history.items
          .filter((item) => item.type === 'message')
          .map((item) => item.textContent),
      ).toContain(GREETING);
    } finally {
      await session.close();
    }
  }, 10_000);
});
