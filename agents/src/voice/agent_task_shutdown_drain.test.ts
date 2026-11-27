// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolError, tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { Future } from '../utils.js';
import { TaskGroup } from '../workflows/task_group.js';
import { Agent, AgentTask } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, CloseReason, type ConversationItemAddedEvent } from './events.js';
import { AudioOutput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

const QUESTION = 'what is your experience';
const GOODBYE = 'thank you for your time, goodbye';

function frame(): AudioFrame {
  return new AudioFrame(new Int16Array(480), 24_000, 1, 480);
}

function audioStream(): ReadableStream<AudioFrame> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(frame());
      controller.close();
    },
  });
}

class ImmediateOutput extends AudioOutput {
  constructor() {
    super(24_000);
  }

  override async captureFrame(audio: AudioFrame): Promise<void> {
    const segments = this.capturedPlayoutSegments;
    await super.captureFrame(audio);
    if (this.capturedPlayoutSegments > segments) this.onPlaybackStarted(Date.now());
  }

  override flush(): void {
    super.flush();
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }

  override clearBuffer(): void {
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    }
  }
}

class HoldingOutput extends AudioOutput {
  readonly started = new Future<void>();
  clearBufferCalls = 0;

  constructor() {
    super(24_000);
  }

  override async captureFrame(audio: AudioFrame): Promise<void> {
    await super.captureFrame(audio);
    this.onPlaybackStarted(Date.now());
    this.started.resolve();
  }

  override clearBuffer(): void {
    this.clearBufferCalls += 1;
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    }
  }

  finish(): void {
    this.flush();
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }
}

const disqualify = tool({
  name: 'disqualify',
  description: 'End the interview and hang up.',
  parameters: z.object({}),
  execute: async (_args, { ctx }) => {
    ctx.session.generateReply({ instructions: 'instructions:say_goodbye' });
    ctx.session.shutdown();
  },
});

const finish = tool({
  name: 'finish',
  description: 'Thank the candidate, end the interview and hang up.',
  parameters: z.object({}),
  execute: async (_args, { ctx }) => {
    ctx.session.generateReply({ instructions: 'instructions:say_goodbye' });
    (ctx.session.currentAgent as InterviewTask).complete('finished');
    ctx.session.shutdown();
  },
});

class InterviewTask extends AgentTask<string> {
  constructor() {
    super({ id: 'interview_task', instructions: 'interview', tools: [disqualify, finish] });
  }

  override async ttsNode(): Promise<ReadableStream<AudioFrame>> {
    return audioStream();
  }

  override async onEnter(): Promise<void> {
    this.session.generateReply({ instructions: 'instructions:ask_question' });
  }
}

class FrameAgent extends Agent {
  override async ttsNode(): Promise<ReadableStream<AudioFrame>> {
    return audioStream();
  }
}

class ParentOnEnter extends FrameAgent {
  constructor() {
    super({ instructions: 'parent' });
  }

  override async onEnter(): Promise<void> {
    try {
      await new InterviewTask().run();
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
    }
  }
}

class ParentWithTaskGroup extends FrameAgent {
  constructor() {
    super({ instructions: 'parent' });
  }

  override async onEnter(): Promise<void> {
    try {
      await new TaskGroup({ summarizeChatCtx: false })
        .add(() => new InterviewTask(), {
          id: 'interview',
          description: 'the interview',
        })
        .run();
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
    }
  }
}

class ParentWithTool extends FrameAgent {
  constructor() {
    super({
      instructions: 'parent',
      tools: [
        tool({
          name: 'start_interview',
          description: 'Start the interview.',
          parameters: z.object({}),
          execute: async () => new InterviewTask().run(),
        }),
      ],
    });
  }
}

class ParentWithToolTaskGroup extends FrameAgent {
  constructor() {
    super({
      instructions: 'parent',
      tools: [
        tool({
          name: 'start_interview',
          description: 'Start the interview.',
          parameters: z.object({}),
          execute: async () =>
            new TaskGroup({ summarizeChatCtx: false })
              .add(() => new InterviewTask(), {
                id: 'interview',
                description: 'the interview',
              })
              .run(),
        }),
      ],
    });
  }
}

type Parent = ParentOnEnter | ParentWithTaskGroup | ParentWithTool | ParentWithToolTaskGroup;

function createSession(output: AudioOutput): AgentSession {
  const session = new AgentSession({
    llm: new FakeLLM([
      { input: 'instructions:ask_question', content: QUESTION },
      { input: 'start', toolCalls: [{ name: 'start_interview', args: {} }] },
      { input: 'disqualify', toolCalls: [{ name: 'disqualify', args: {} }] },
      { input: 'finish', toolCalls: [{ name: 'finish', args: {} }] },
      { input: 'instructions:say_goodbye', content: GOODBYE },
      { input: 'AgentTask interview_task is cancelled', content: 'sorry, something went wrong' },
      { input: 'finished', content: 'the interview is finished' },
      { input: '"finished"', content: 'the interview is finished' },
    ]),
    turnHandling: { turnDetection: 'manual' },
  });
  session.output.audio = output;
  return session;
}

function observeSession(session: AgentSession) {
  const messages: Array<[string | undefined, boolean]> = [];
  const closed = new Future<CloseReason>();
  session.on(AgentSessionEventTypes.ConversationItemAdded, (ev: ConversationItemAddedEvent) => {
    if (ev.item.type === 'message' && ev.item.role === 'assistant') {
      messages.push([ev.item.textContent, ev.item.interrupted ?? false]);
    }
  });
  session.on(AgentSessionEventTypes.Close, (ev) => closed.resolve(ev.reason));
  return { messages, closed };
}

async function startInterview(session: AgentSession, parent: Parent): Promise<void> {
  await session.start({ agent: parent });
  if (parent instanceof ParentWithTool || parent instanceof ParentWithToolTaskGroup) {
    session.generateReply({ userInput: 'start' });
  }
  await vi.waitFor(() => expect(session.currentAgent).toBeInstanceOf(InterviewTask));
  await vi.waitFor(() =>
    expect(
      session.chatCtx.items.some(
        (item) =>
          item.type === 'message' && item.role === 'assistant' && item.textContent === QUESTION,
      ),
    ).toBe(true),
  );
}

describe('AgentTask shutdown drain', () => {
  beforeAll(() => initializeLogger({ pretty: false, level: 'silent' }));

  it('lets an AgentTask finish its sentence during drained shutdown', async () => {
    const output = new HoldingOutput();
    const session = createSession(output);
    const { messages, closed } = observeSession(session);
    try {
      await session.start({ agent: new ParentOnEnter() });
      await output.started.await;
      session.shutdown();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(output.clearBufferCalls).toBe(0);
      output.finish();
      expect(await closed.await).toBe(CloseReason.USER_INITIATED);
      expect(messages).toEqual([[QUESTION, false]]);
    } finally {
      output.finish();
      await session.close();
    }
  });

  it.each([
    ['onEnter', () => new ParentOnEnter()],
    ['TaskGroup', () => new ParentWithTaskGroup()],
    ['parent tool', () => new ParentWithTool()],
    ['TaskGroup in a parent tool', () => new ParentWithToolTaskGroup()],
  ] as const)('plays a goodbye queued before shutdown from %s', async (_name, createParent) => {
    const session = createSession(new ImmediateOutput());
    const { messages, closed } = observeSession(session);
    try {
      await startInterview(session, createParent());
      session.generateReply({ userInput: 'disqualify' });
      expect(await closed.await).toBe(CloseReason.USER_INITIATED);
      expect(messages).toEqual([
        [QUESTION, false],
        [GOODBYE, false],
      ]);
    } finally {
      await session.close();
    }
  });

  it('keeps the goodbye and parent reply when the task completed before shutdown', async () => {
    const session = createSession(new ImmediateOutput());
    const { messages, closed } = observeSession(session);
    try {
      await startInterview(session, new ParentWithTool());
      session.generateReply({ userInput: 'finish' });
      expect(await closed.await).toBe(CloseReason.USER_INITIATED);
      expect(messages).toEqual([
        [QUESTION, false],
        [GOODBYE, false],
        ['the interview is finished', false],
      ]);
    } finally {
      await session.close();
    }
  });

  it('still interrupts an AgentTask when shutdown does not drain', async () => {
    const output = new HoldingOutput();
    const session = createSession(output);
    const { messages, closed } = observeSession(session);
    try {
      await session.start({ agent: new ParentOnEnter() });
      await output.started.await;
      session.shutdown({ drain: false });
      expect(await closed.await).toBe(CloseReason.USER_INITIATED);
      expect(output.clearBufferCalls).toBeGreaterThan(0);
      expect(messages).not.toEqual([[QUESTION, false]]);
    } finally {
      output.finish();
      await session.close();
    }
  });
});
