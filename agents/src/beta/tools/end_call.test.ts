// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { type JobContext, runWithJobContext } from '../../job.js';
import { FunctionCall } from '../../llm/chat_context.js';
import { type FunctionTool, RealtimeModel, type RealtimeSession } from '../../llm/index.js';
import { AgentSessionEventTypes, type CloseEvent } from '../../voice/events.js';
import { RunContext } from '../../voice/run_context.js';
import { SpeechHandle } from '../../voice/speech_handle.js';
import { EndCallTool } from './end_call.js';

function makeFunctionCall(): FunctionCall {
  return FunctionCall.create({
    callId: 'call_test',
    name: 'end_call',
    args: '{}',
  });
}

function makeRunContext() {
  const speechHandle = SpeechHandle.create();
  const session = Object.assign(new EventEmitter(), {
    currentAgent: {
      getActivityOrThrow: () => ({ llm: undefined }),
    },
    shutdown: vi.fn(),
  });

  return {
    ctx: new RunContext(session as never, speechHandle, makeFunctionCall()),
    session,
    speechHandle,
  };
}

function makeCloseEvent(reason = 'end_call'): CloseEvent {
  return {
    type: 'close',
    error: null,
    reason,
    createdAt: Date.now(),
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

class FakeRealtimeModel extends RealtimeModel {
  constructor(autoToolReplyGeneration: boolean) {
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration,
      audioOutput: true,
      manualFunctionCalls: true,
    });
  }

  get model(): string {
    return 'fake-realtime';
  }

  session(): RealtimeSession {
    throw new Error('not implemented');
  }

  async close(): Promise<void> {}
}

describe('EndCallTool', () => {
  it('exposes an end_call function tool', () => {
    const endCallTool = new EndCallTool({ deleteRoom: false });

    expect(endCallTool.tools.end_call).toBeDefined();
    expect(endCallTool.tools.end_call.type).toBe('function');
  });

  it('returns end instructions and waits for speech playout before shutdown', async () => {
    const onToolCalled = vi.fn();
    const onToolCompleted = vi.fn();
    const endCallTool = new EndCallTool({
      deleteRoom: false,
      endInstructions: 'thank the user and say goodbye',
      onToolCalled,
      onToolCompleted,
    });
    const { ctx, session, speechHandle } = makeRunContext();
    const endCall = endCallTool.tools.end_call as FunctionTool;

    const result = await endCall.execute({}, { ctx, toolCallId: 'tool_call_test' });

    expect(result).toBe('thank the user and say goodbye');
    expect(onToolCalled).toHaveBeenCalledWith({ ctx, arguments: {} });
    expect(onToolCompleted).toHaveBeenCalledWith({
      ctx,
      output: 'thank the user and say goodbye',
    });
    expect(session.shutdown).not.toHaveBeenCalled();

    speechHandle._markDone();
    await flushMicrotasks();

    expect(session.shutdown).toHaveBeenCalledWith({ drain: true, reason: 'end_call' });
  });

  it('returns undefined when end instructions are null', async () => {
    const endCallTool = new EndCallTool({
      deleteRoom: false,
      endInstructions: null,
    });
    const { ctx, session, speechHandle } = makeRunContext();
    const endCall = endCallTool.tools.end_call as FunctionTool;

    const result = await endCall.execute({}, { ctx, toolCallId: 'tool_call_test' });

    expect(result).toBeUndefined();
    expect(session.shutdown).not.toHaveBeenCalled();

    speechHandle._markDone();
    await flushMicrotasks();

    expect(session.shutdown).toHaveBeenCalledWith({ drain: true, reason: 'end_call' });
  });

  it('shuts down the job after the session closes', async () => {
    const endCallTool = new EndCallTool({ deleteRoom: false });
    const { ctx, session, speechHandle } = makeRunContext();
    const endCall = endCallTool.tools.end_call as FunctionTool;
    const jobCtx = {
      addShutdownCallback: vi.fn(),
      shutdown: vi.fn(),
    };

    await runWithJobContext(jobCtx as unknown as JobContext, () =>
      endCall.execute({}, { ctx, toolCallId: 'tool_call_test' }),
    );

    speechHandle._markDone();
    await flushMicrotasks();

    expect(jobCtx.shutdown).not.toHaveBeenCalled();

    session.emit(AgentSessionEventTypes.Close, makeCloseEvent());

    expect(jobCtx.addShutdownCallback).not.toHaveBeenCalled();
    expect(jobCtx.shutdown).toHaveBeenCalledWith('end_call');
  });

  it('registers room deletion before job shutdown when configured', async () => {
    const endCallTool = new EndCallTool({ deleteRoom: true });
    const { ctx, session, speechHandle } = makeRunContext();
    const endCall = endCallTool.tools.end_call as FunctionTool;
    const jobCtx = {
      addShutdownCallback: vi.fn(),
      shutdown: vi.fn(),
    };

    await runWithJobContext(jobCtx as unknown as JobContext, () =>
      endCall.execute({}, { ctx, toolCallId: 'tool_call_test' }),
    );

    speechHandle._markDone();
    await flushMicrotasks();
    session.emit(AgentSessionEventTypes.Close, makeCloseEvent());

    expect(jobCtx.addShutdownCallback).toHaveBeenCalledTimes(1);
    expect(jobCtx.shutdown).toHaveBeenCalledWith('end_call');
  });

  it('waits for auto-generated realtime tool reply speech before shutdown', async () => {
    const endCallTool = new EndCallTool({ deleteRoom: false });
    const speechHandle = SpeechHandle.create();
    const replySpeechHandle = SpeechHandle.create();
    const session = Object.assign(new EventEmitter(), {
      currentAgent: {
        getActivityOrThrow: () => ({ llm: new FakeRealtimeModel(true) }),
      },
      shutdown: vi.fn(),
    });
    const ctx = new RunContext(session as never, speechHandle, makeFunctionCall());
    const endCall = endCallTool.tools.end_call as FunctionTool;

    await endCall.execute({}, { ctx, toolCallId: 'tool_call_test' });

    session.emit(AgentSessionEventTypes.SpeechCreated, {
      type: 'speech_created',
      userInitiated: false,
      source: 'generate_reply',
      speechHandle: replySpeechHandle,
      createdAt: Date.now(),
    });
    replySpeechHandle._markDone();

    expect(session.shutdown).not.toHaveBeenCalled();

    speechHandle._markDone();
    await flushMicrotasks();

    expect(session.shutdown).toHaveBeenCalledWith({ drain: true, reason: 'end_call' });
  });

  it('does not register duplicate shutdown callbacks after repeated calls', async () => {
    const endCallTool = new EndCallTool({ deleteRoom: false });
    const { ctx, session, speechHandle } = makeRunContext();
    const endCall = endCallTool.tools.end_call as FunctionTool;

    await endCall.execute({}, { ctx, toolCallId: 'first_call' });
    await endCall.execute({}, { ctx, toolCallId: 'second_call' });

    speechHandle._markDone();
    await flushMicrotasks();

    expect(session.shutdown).toHaveBeenCalledTimes(1);
  });

  it('allows the same tool instance to end a later call', async () => {
    const endCallTool = new EndCallTool({ deleteRoom: false });
    const first = makeRunContext();
    const second = makeRunContext();
    const endCall = endCallTool.tools.end_call as FunctionTool;

    await endCall.execute({}, { ctx: first.ctx, toolCallId: 'first_call' });
    first.speechHandle._markDone();
    await flushMicrotasks();

    await endCall.execute({}, { ctx: second.ctx, toolCallId: 'second_call' });
    second.speechHandle._markDone();
    await flushMicrotasks();

    expect(first.session.shutdown).toHaveBeenCalledWith({ drain: true, reason: 'end_call' });
    expect(second.session.shutdown).toHaveBeenCalledWith({ drain: true, reason: 'end_call' });
  });
});
