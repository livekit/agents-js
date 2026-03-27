// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';

function createFakeLock() {
  return {
    lock: vi.fn(async () => () => {}),
  };
}

function createFakeSession() {
  return {
    activityLock: createFakeLock(),
    rootSpanContext: undefined,
    agent: undefined,
    activity: undefined,
    nextActivity: undefined,
    _globalRunState: undefined,
    _chatCtx: ChatContext.empty(),
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    sessionOptions: {
      turnHandling: {
        interruption: {
          enabled: true,
          minDuration: 0,
          minWords: 0,
        },
        endpointing: {
          minDelay: 0,
          maxDelay: 0,
        },
      },
    },
    interruptionDetection: undefined,
    turnDetection: undefined,
    vad: undefined,
    stt: undefined,
    llm: undefined,
    tts: undefined,
    useTtsAlignedTranscript: false,
    _input: {},
  } as unknown as AgentSession;
}

describe('AgentSession STT pipeline handoff', () => {
  it('passes a detached STT pipeline into the next resumed activity', async () => {
    const pipeline = {
      close: vi.fn(async () => {}),
    };
    const previousAgent = new Agent({ instructions: 'old' });
    const nextAgent = new Agent({ instructions: 'new' });
    const previousActivity = {
      agent: previousAgent,
      _detachSttPipelineIfReusable: vi.fn(async () => pipeline),
      drain: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
    };
    const nextActivity = {
      agent: nextAgent,
      resume: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      attachAudioInput: vi.fn(),
      _onEnterTask: undefined,
    };
    nextAgent._agentActivity = nextActivity as any;

    const session = createFakeSession();
    (session as any).activity = previousActivity as any;

    await AgentSession.prototype._updateActivity.call(session, nextAgent, {
      newActivity: 'resume',
      waitOnEnter: false,
    });

    expect(previousActivity._detachSttPipelineIfReusable).toHaveBeenCalledWith(nextActivity);
    expect(nextActivity.resume).toHaveBeenCalledWith({ reuseSttPipeline: pipeline });
    expect(pipeline.close).not.toHaveBeenCalled();
  });

  it('closes the detached pipeline if the next activity fails to start', async () => {
    const pipeline = {
      close: vi.fn(async () => {}),
    };
    const previousAgent = new Agent({ instructions: 'old' });
    const nextAgent = new Agent({ instructions: 'new' });
    const previousActivity = {
      agent: previousAgent,
      _detachSttPipelineIfReusable: vi.fn(async () => pipeline),
      drain: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
    };
    const nextActivity = {
      agent: nextAgent,
      resume: vi.fn(async () => {
        throw new Error('resume failed');
      }),
      start: vi.fn(async () => {}),
      attachAudioInput: vi.fn(),
      _onEnterTask: undefined,
    };
    nextAgent._agentActivity = nextActivity as any;

    const session = createFakeSession();
    (session as any).activity = previousActivity as any;

    await expect(
      AgentSession.prototype._updateActivity.call(session, nextAgent, {
        newActivity: 'resume',
        waitOnEnter: false,
      }),
    ).rejects.toThrow('resume failed');

    expect(pipeline.close).toHaveBeenCalledTimes(1);
  });

  it('does not close the adopted pipeline after the next activity starts successfully', async () => {
    const pipeline = {
      close: vi.fn(async () => {}),
    };
    const previousAgent = new Agent({ instructions: 'old' });
    const nextAgent = new Agent({ instructions: 'new' });
    const previousActivity = {
      agent: previousAgent,
      _detachSttPipelineIfReusable: vi.fn(async () => pipeline),
      drain: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
    };
    const nextActivity = {
      agent: nextAgent,
      resume: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      attachAudioInput: vi.fn(() => {
        throw new Error('attach failed');
      }),
      _onEnterTask: undefined,
    };
    nextAgent._agentActivity = nextActivity as any;

    const session = createFakeSession();
    (session as any).activity = previousActivity as any;
    (session as any)._input = { audio: { stream: {} } } as any;

    await expect(
      AgentSession.prototype._updateActivity.call(session, nextAgent, {
        newActivity: 'resume',
        waitOnEnter: false,
      }),
    ).rejects.toThrow('attach failed');

    expect(nextActivity.resume).toHaveBeenCalledWith({ reuseSttPipeline: pipeline });
    expect(pipeline.close).not.toHaveBeenCalled();
  });

  it('skips STT detach when the same activity object is reused', async () => {
    const agent = new Agent({ instructions: 'same' });
    const activity = {
      agent,
      _detachSttPipelineIfReusable: vi.fn(async () => undefined),
      drain: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      attachAudioInput: vi.fn(),
      _onEnterTask: undefined,
    };
    agent._agentActivity = activity as any;

    const session = createFakeSession();
    (session as any).activity = activity as any;

    await AgentSession.prototype._updateActivity.call(session, agent, {
      newActivity: 'resume',
      waitOnEnter: false,
    });

    expect(activity._detachSttPipelineIfReusable).not.toHaveBeenCalled();
    expect(activity.resume).toHaveBeenCalledWith({ reuseSttPipeline: undefined });
  });

  it('skips starting a new activity while the session is closing and closes the detached pipeline', async () => {
    const pipeline = {
      close: vi.fn(async () => {}),
    };
    const previousAgent = new Agent({ instructions: 'old' });
    const nextAgent = new Agent({ instructions: 'new' });
    const previousActivity = {
      agent: previousAgent,
      _detachSttPipelineIfReusable: vi.fn(async () => pipeline),
      drain: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
    };

    const startSpy = vi.spyOn(AgentActivity.prototype, 'start').mockResolvedValue(undefined);

    try {
      const session = createFakeSession();
      (session as any).activity = previousActivity as any;
      (session as any).closing = true;

      await AgentSession.prototype._updateActivity.call(session, nextAgent, {
        newActivity: 'start',
        waitOnEnter: false,
      });

      expect(previousActivity._detachSttPipelineIfReusable).toHaveBeenCalledTimes(1);
      expect(previousActivity.close).toHaveBeenCalledTimes(1);
      expect(pipeline.close).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
      expect((session as any).activity).toBeUndefined();
      expect((session as any).nextActivity).toBeUndefined();
    } finally {
      startSpy.mockRestore();
    }
  });
});
