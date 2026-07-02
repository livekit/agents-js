// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { AgentHandoffItem, ChatContext } from '../llm/chat_context.js';
import { Agent } from './agent.js';
import { AgentActivity, type ReusableResources } from './agent_activity.js';
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
    _conversationItemAdded: vi.fn(),
    emit: vi.fn(),
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

describe('AgentSession reusable resources handoff', () => {
  it('passes reusable resources from drain into the next resumed activity', async () => {
    const resources: ReusableResources = {
      sttPipeline: { close: vi.fn(async () => {}) } as any,
    };
    const previousAgent = new Agent({ instructions: 'old' });
    const nextAgent = new Agent({ instructions: 'new' });
    const previousActivity = {
      agent: previousAgent,
      drain: vi.fn(async () => resources),
      close: vi.fn(async () => {}),
      pause: vi.fn(async () => resources),
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

    expect(previousActivity.drain).toHaveBeenCalledWith({ newActivity: nextActivity });
    expect(nextActivity.resume).toHaveBeenCalledWith({ reuseResources: resources });
  });

  it('cleans up reusable resources if the next activity fails to start', async () => {
    const closeFn = vi.fn(async () => {});
    const resources: ReusableResources = {
      sttPipeline: { close: closeFn } as any,
    };
    const previousAgent = new Agent({ instructions: 'old' });
    const nextAgent = new Agent({ instructions: 'new' });
    const previousActivity = {
      agent: previousAgent,
      drain: vi.fn(async () => resources),
      close: vi.fn(async () => {}),
      pause: vi.fn(async () => resources),
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

    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it('does not cleanup reusable resources after the next activity starts successfully', async () => {
    const closeFn = vi.fn(async () => {});
    const resources: ReusableResources = {
      sttPipeline: { close: closeFn } as any,
    };
    const previousAgent = new Agent({ instructions: 'old' });
    const nextAgent = new Agent({ instructions: 'new' });
    const previousActivity = {
      agent: previousAgent,
      drain: vi.fn(async () => resources),
      close: vi.fn(async () => {}),
      pause: vi.fn(async () => resources),
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

    expect(nextActivity.resume).toHaveBeenCalledWith({ reuseResources: resources });
    // pipeline was already transferred, so cleanup should NOT have been called
    expect(closeFn).not.toHaveBeenCalled();
  });

  it('skips detach when the same activity object is reused', async () => {
    const agent = new Agent({ instructions: 'same' });
    const activity = {
      agent,
      drain: vi.fn(async () => undefined),
      close: vi.fn(async () => {}),
      pause: vi.fn(async () => undefined),
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

    expect(activity.drain).not.toHaveBeenCalled();
    expect(activity.pause).not.toHaveBeenCalled();
    expect(activity.resume).toHaveBeenCalledWith({ reuseResources: undefined });
  });

  it('emits ConversationItemAdded with an AgentHandoffItem on handoff', async () => {
    const previousAgent = new Agent({ instructions: 'old' });
    const nextAgent = new Agent({ instructions: 'new' });
    const previousActivity = {
      agent: previousAgent,
      drain: vi.fn(async () => undefined),
      close: vi.fn(async () => {}),
      pause: vi.fn(async () => undefined),
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

    expect((session as any)._conversationItemAdded).toHaveBeenCalledOnce();
    const item = (session as any)._conversationItemAdded.mock.calls[0][0];
    expect(item).toBeInstanceOf(AgentHandoffItem);
    expect(item.oldAgentId).toBe(previousAgent.id);
    expect(item.newAgentId).toBe(nextAgent.id);
  });

  it('skips starting a new activity while the session is closing and cleans up resources', async () => {
    const closeFn = vi.fn(async () => {});
    const resources: ReusableResources = {
      sttPipeline: { close: closeFn } as any,
    };
    const previousAgent = new Agent({ instructions: 'old' });
    const nextAgent = new Agent({ instructions: 'new' });
    const previousActivity = {
      agent: previousAgent,
      drain: vi.fn(async () => resources),
      close: vi.fn(async () => {}),
      pause: vi.fn(async () => resources),
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

      expect(previousActivity.drain).toHaveBeenCalledTimes(1);
      expect(previousActivity.close).toHaveBeenCalledTimes(1);
      expect(closeFn).toHaveBeenCalledTimes(1);
      expect(startSpy).not.toHaveBeenCalled();
      expect((session as any).activity).toBeUndefined();
      expect((session as any).nextActivity).toBeUndefined();
    } finally {
      startSpy.mockRestore();
    }
  });
});
