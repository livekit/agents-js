// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import type { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { type RealtimeCapabilities, RealtimeModel, type RealtimeSession } from '../llm/realtime.js';
import { initializeLogger, log } from '../log.js';
import type { SpeechEvent } from '../stt/stt.js';
import { Agent, type ModelSettings } from './agent.js';
import {
  AgentActivity,
  type ReusableResources,
  cleanupReusableResources,
} from './agent_activity.js';
import type { EndOfTurnInfo } from './audio_recognition.js';
import type { UserTurnExceededEvent } from './events.js';

initializeLogger({ pretty: false, level: 'silent' });

type FakeActivity = {
  agent: Agent;
  audioRecognition:
    | { detachSttPipeline: ReturnType<typeof vi.fn>; inputStartedAt?: number }
    | undefined;
  stt: unknown;
  llm: unknown;
  tools: unknown;
  realtimeSession: unknown;
};

function createFakeActivity(agent: Agent, stt: unknown, inputStartedAt?: number) {
  const detachedPipeline = { id: Symbol('pipeline') };
  const activity = {
    agent,
    audioRecognition: {
      detachSttPipeline: vi.fn(async () => detachedPipeline),
      inputStartedAt,
    },
    stt,
    llm: undefined,
    tools: [],
    realtimeSession: undefined,
  } as FakeActivity;

  return { activity, detachedPipeline };
}

async function detachResources(
  oldActivity: FakeActivity,
  newActivity: FakeActivity,
): Promise<ReusableResources> {
  // Access private method via prototype for testing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (AgentActivity.prototype as any)._detachReusableResources as (
    this: FakeActivity,
    newActivity: FakeActivity,
  ) => Promise<ReusableResources>;
  return await fn.call(oldActivity, newActivity);
}

describe('AgentActivity STT handoff reuse eligibility', () => {
  it('reuses the pipeline when both activities share the same STT instance and sttNode', async () => {
    const sharedStt = { id: 'shared-stt' };
    const oldActivity = createFakeActivity(new Agent({ instructions: 'a' }), sharedStt);
    const newActivity = createFakeActivity(new Agent({ instructions: 'b' }), sharedStt);

    const resources = await detachResources(oldActivity.activity, newActivity.activity);

    expect(resources.sttPipeline).toBe(oldActivity.detachedPipeline);
    expect(oldActivity.activity.audioRecognition?.detachSttPipeline).toHaveBeenCalledTimes(1);
  });

  it('carries the original input start time with a reused STT pipeline', async () => {
    const sharedStt = { id: 'shared-stt' };
    const oldInputStartedAt = Date.now() - 60_000;
    const oldActivity = createFakeActivity(
      new Agent({ instructions: 'a' }),
      sharedStt,
      oldInputStartedAt,
    );
    const newActivity = createFakeActivity(new Agent({ instructions: 'b' }), sharedStt);

    const resources = await detachResources(oldActivity.activity, newActivity.activity);

    expect(resources.sttPipeline).toBe(oldActivity.detachedPipeline);
    expect(resources.sttInputStartedAt).toBe(oldInputStartedAt);
  });

  it('does not reuse when the STT instances differ', async () => {
    const oldActivity = createFakeActivity(new Agent({ instructions: 'a' }), { id: 'stt-a' });
    const newActivity = createFakeActivity(new Agent({ instructions: 'b' }), { id: 'stt-b' });

    const resources = await detachResources(oldActivity.activity, newActivity.activity);

    expect(resources.sttPipeline).toBeUndefined();
    expect(oldActivity.activity.audioRecognition?.detachSttPipeline).not.toHaveBeenCalled();
  });

  it('does not reuse when either activity has no STT', async () => {
    const sharedStt = { id: 'shared-stt' };
    const oldActivity = createFakeActivity(new Agent({ instructions: 'a' }), undefined);
    const newActivity = createFakeActivity(new Agent({ instructions: 'b' }), sharedStt);

    const resources = await detachResources(oldActivity.activity, newActivity.activity);

    expect(resources.sttPipeline).toBeUndefined();
    expect(oldActivity.activity.audioRecognition?.detachSttPipeline).not.toHaveBeenCalled();
  });

  it('does not reuse when the agents override sttNode differently', async () => {
    const sharedStt = { id: 'shared-stt' };

    class AgentA extends Agent {
      async sttNode(_audio: ReadableStream<AudioFrame>, _modelSettings: ModelSettings) {
        return null as ReadableStream<SpeechEvent | string> | null;
      }
    }

    class AgentB extends Agent {
      async sttNode(_audio: ReadableStream<AudioFrame>, _modelSettings: ModelSettings) {
        return null as ReadableStream<SpeechEvent | string> | null;
      }
    }

    const oldActivity = createFakeActivity(new AgentA({ instructions: 'a' }), sharedStt);
    const newActivity = createFakeActivity(new AgentB({ instructions: 'b' }), sharedStt);

    const resources = await detachResources(oldActivity.activity, newActivity.activity);

    expect(resources.sttPipeline).toBeUndefined();
    expect(oldActivity.activity.audioRecognition?.detachSttPipeline).not.toHaveBeenCalled();
  });

  it('does not reuse when the new agent inherits the same custom sttNode implementation', async () => {
    const sharedStt = { id: 'shared-stt' };

    class AgentA extends Agent {
      async sttNode(_audio: ReadableStream<AudioFrame>, _modelSettings: ModelSettings) {
        return null as ReadableStream<SpeechEvent | string> | null;
      }
    }

    class AgentB extends AgentA {}

    const oldActivity = createFakeActivity(new AgentA({ instructions: 'a' }), sharedStt);
    const newActivity = createFakeActivity(new AgentB({ instructions: 'b' }), sharedStt);

    const resources = await detachResources(oldActivity.activity, newActivity.activity);

    expect(resources.sttPipeline).toBeUndefined();
    expect(oldActivity.activity.audioRecognition?.detachSttPipeline).not.toHaveBeenCalled();
  });

  it('does not reuse when the old activity has no audioRecognition', async () => {
    const sharedStt = { id: 'shared-stt' };
    const oldActivity = createFakeActivity(new Agent({ instructions: 'a' }), sharedStt);
    const newActivity = createFakeActivity(new Agent({ instructions: 'b' }), sharedStt);
    oldActivity.activity.audioRecognition = undefined;

    const resources = await detachResources(oldActivity.activity, newActivity.activity);

    expect(resources.sttPipeline).toBeUndefined();
  });
});

describe('AgentActivity RT session reuse eligibility', () => {
  function createFakeRtSession(): RealtimeSession {
    return {
      chatCtx: ChatContext.empty(),
      off: vi.fn(),
      on: vi.fn(),
      interrupt: vi.fn(),
      clearAudio: vi.fn(),
      close: vi.fn(async () => {}),
    } as unknown as RealtimeSession;
  }

  class FakeRealtimeModel extends RealtimeModel {
    get model() {
      return 'fake';
    }
    label(): string {
      return 'fake.RealtimeModel';
    }
    session(): RealtimeSession {
      throw new Error('not implemented');
    }
    async close() {}
  }

  function createFakeRealtimeModel(capabilitiesOverrides: Partial<RealtimeCapabilities> = {}) {
    const capabilities: RealtimeCapabilities = {
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: false,
      audioOutput: true,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: false,
      midSessionInstructionsUpdate: false,
      midSessionToolsUpdate: false,
      ...capabilitiesOverrides,
    };
    return new FakeRealtimeModel(capabilities);
  }

  function createRtActivity(agent: Agent, llm: unknown, rtSession?: RealtimeSession): FakeActivity {
    return {
      agent,
      audioRecognition: undefined,
      stt: undefined,
      llm,
      tools: agent.toolCtx,
      realtimeSession: rtSession,
    };
  }

  it('reuses RT session when same LLM, same instructions, equivalent context, and same tools', async () => {
    const sharedLlm = createFakeRealtimeModel();
    const rtSession = createFakeRtSession();

    const oldAgent = new Agent({ instructions: 'hello' });
    const newAgent = new Agent({ instructions: 'hello' });
    const oldActivity = createRtActivity(oldAgent, sharedLlm, rtSession);
    const newActivity = createRtActivity(newAgent, sharedLlm);

    const resources = await detachResources(oldActivity, newActivity);

    expect(resources.rtSession).toBe(rtSession);
    expect(oldActivity.realtimeSession).toBeUndefined();
    expect(rtSession.off).toHaveBeenCalled();
  });

  it('does not reuse RT session when LLM instances differ', async () => {
    const rtSession = createFakeRtSession();

    const oldLlm = createFakeRealtimeModel();
    const newLlm = createFakeRealtimeModel();
    const oldActivity = createRtActivity(new Agent({ instructions: 'a' }), oldLlm, rtSession);
    const newActivity = createRtActivity(new Agent({ instructions: 'a' }), newLlm);

    const resources = await detachResources(oldActivity, newActivity);

    expect(resources.rtSession).toBeUndefined();
  });

  it('does not reuse RT session when instructions differ and midSessionInstructionsUpdate is false', async () => {
    const sharedLlm = createFakeRealtimeModel({ midSessionInstructionsUpdate: false });
    const rtSession = createFakeRtSession();

    const oldActivity = createRtActivity(new Agent({ instructions: 'old' }), sharedLlm, rtSession);
    const newActivity = createRtActivity(new Agent({ instructions: 'new' }), sharedLlm);

    const resources = await detachResources(oldActivity, newActivity);

    expect(resources.rtSession).toBeUndefined();
  });

  it('reuses RT session when instructions differ but midSessionInstructionsUpdate is true', async () => {
    const sharedLlm = createFakeRealtimeModel({ midSessionInstructionsUpdate: true });
    const rtSession = createFakeRtSession();

    const oldActivity = createRtActivity(new Agent({ instructions: 'old' }), sharedLlm, rtSession);
    const newActivity = createRtActivity(new Agent({ instructions: 'new' }), sharedLlm);

    const resources = await detachResources(oldActivity, newActivity);

    expect(resources.rtSession).toBe(rtSession);
  });

  it('reuses RT session when context differs but midSessionChatCtxUpdate is true', async () => {
    const sharedLlm = createFakeRealtimeModel({ midSessionChatCtxUpdate: true });
    const rtSession = createFakeRtSession();

    const oldActivity = createRtActivity(new Agent({ instructions: 'same' }), sharedLlm, rtSession);
    const newActivity = createRtActivity(new Agent({ instructions: 'same' }), sharedLlm);

    const resources = await detachResources(oldActivity, newActivity);

    expect(resources.rtSession).toBe(rtSession);
  });

  it('does not reuse when no RT session exists', async () => {
    const sharedLlm = createFakeRealtimeModel();
    const oldActivity = createRtActivity(new Agent({ instructions: 'a' }), sharedLlm, undefined);
    const newActivity = createRtActivity(new Agent({ instructions: 'a' }), sharedLlm);

    const resources = await detachResources(oldActivity, newActivity);

    expect(resources.rtSession).toBeUndefined();
  });

  it('does not reuse when LLM is not a RealtimeModel', async () => {
    const rtSession = createFakeRtSession();
    const nonRealtimeLlm = { id: 'plain-llm' };

    const oldActivity = createRtActivity(
      new Agent({ instructions: 'a' }),
      nonRealtimeLlm,
      rtSession,
    );
    const newActivity = createRtActivity(new Agent({ instructions: 'a' }), nonRealtimeLlm);

    const resources = await detachResources(oldActivity, newActivity);

    expect(resources.rtSession).toBeUndefined();
  });
});

describe('AgentActivity blockNewTurns (handoff transition)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function createBareActivity(): any {
    const activity = Object.create(AgentActivity.prototype);
    activity.logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    activity.cancelPreemptiveGeneration = vi.fn();
    activity.createSpeechTask = vi.fn(() => ({ cancel: vi.fn() }));
    return activity;
  }

  const endOfTurnInfo: EndOfTurnInfo = {
    newTranscript: 'hello again',
    transcriptConfidence: 1,
    transcriptionDelay: 0,
    endOfUtteranceDelay: 0,
    startedSpeakingAt: undefined,
    stoppedSpeakingAt: undefined,
  };

  // Regression for the mis-ported #5396 fix: blockNewTurns() must gate the speech
  // scheduling paths (here onEndOfTurn) during the handoff transition window — even
  // before drain() flips schedulingPaused — so a user turn arriving in that window is
  // dropped instead of scheduling a reply against the outgoing agent.
  it('onEndOfTurn skips a new user turn while new turns are blocked, even when scheduling is still running', async () => {
    const activity = createBareActivity();
    activity._schedulingPaused = false; // scheduling still running (pre-drain window)
    activity.newTurnsBlocked = false;

    (activity as AgentActivity).blockNewTurns();
    const handled = await (activity as AgentActivity).onEndOfTurn(endOfTurnInfo);

    expect(handled).toBe(true);
    expect(activity.cancelPreemptiveGeneration).toHaveBeenCalledTimes(1);
    // The turn is dropped at the guard; userTurnCompleted is never scheduled.
    expect(activity.createSpeechTask).not.toHaveBeenCalled();
  });

  it('onEndOfTurn schedules the turn normally when new turns are not blocked', async () => {
    const activity = createBareActivity();
    activity._schedulingPaused = false;
    activity.newTurnsBlocked = false;
    // `get stt` returns undefined here, short-circuiting the interruption branch.
    activity.agent = { stt: undefined };
    activity.agentSession = { stt: undefined };
    activity._currentSpeech = undefined;
    activity._userTurnCompletedTask = undefined;

    const handled = await (activity as AgentActivity).onEndOfTurn(endOfTurnInfo);

    expect(handled).toBe(true);
    expect(activity.createSpeechTask).toHaveBeenCalledTimes(1);
  });

  // The bot's port wrongly gated the user-turn-exceeded callback on newTurnsBlocked;
  // Python never does. onUserTurnExceeded must stay independent of the handoff flag.
  it('onUserTurnExceeded is independent of newTurnsBlocked', () => {
    const activity = createBareActivity();
    activity._schedulingPaused = false;
    activity.newTurnsBlocked = false;
    activity.userTurnExceededLocked = false;
    activity.userTurnExceededTask = undefined;

    (activity as AgentActivity).blockNewTurns();

    const ev: UserTurnExceededEvent = {
      type: 'user_turn_exceeded',
      transcript: 'hi',
      accumulatedTranscript: 'hi',
      accumulatedWordCount: 10,
      duration: 5000,
      createdAt: Date.now(),
    };
    (activity as AgentActivity).onUserTurnExceeded(ev);

    expect(activity.createSpeechTask).toHaveBeenCalledTimes(1);
  });

  // When new turns are blocked before the turn completes, the reply must be skipped
  // before onUserTurnCompleted runs. When the session is not closing, the message
  // is dropped instead of being added to the chat context.
  it('userTurnCompleted skips before the callback when new turns are blocked (not closing)', async () => {
    const activity = createBareActivity();
    activity._schedulingPaused = false;
    activity.newTurnsBlocked = false;
    activity._currentSpeech = undefined;
    const onUserTurnCompleted = vi.fn(async () => {});
    activity.agent = { llm: undefined, chatCtx: ChatContext.empty(), onUserTurnCompleted };
    activity.agentSession = { llm: undefined, _closing: false, _conversationItemAdded: vi.fn() };

    (activity as AgentActivity).blockNewTurns();
    await (activity as any).userTurnCompleted(endOfTurnInfo);

    expect(onUserTurnCompleted).not.toHaveBeenCalled();
    expect(activity.agentSession._conversationItemAdded).not.toHaveBeenCalled();
    expect(activity.createSpeechTask).not.toHaveBeenCalled();
  });

  // The skipped message is still committed to the chat context when the session is
  // closing, so it is not lost.
  it('userTurnCompleted commits the skipped message to chat ctx when closing', async () => {
    const activity = createBareActivity();
    activity._schedulingPaused = false;
    activity.newTurnsBlocked = false;
    activity._currentSpeech = undefined;
    const push = vi.fn();
    const conversationItemAdded = vi.fn();
    activity.agent = {
      llm: undefined,
      chatCtx: ChatContext.empty(),
      _chatCtx: { items: { push } },
      onUserTurnCompleted: vi.fn(async () => {}),
    };
    activity.agentSession = {
      llm: undefined,
      _closing: true,
      _conversationItemAdded: conversationItemAdded,
    };

    (activity as AgentActivity).blockNewTurns();
    await (activity as any).userTurnCompleted(endOfTurnInfo);

    expect(push).toHaveBeenCalledTimes(1);
    expect(conversationItemAdded).toHaveBeenCalledTimes(1);
    expect(activity.createSpeechTask).not.toHaveBeenCalled();
  });

  // The post-callback re-check catches a handoff triggered inside
  // onUserTurnCompleted, so no reply is scheduled against the outgoing agent even
  // though new turns were not blocked when the turn started.
  it('userTurnCompleted re-checks after the callback when a handoff blocks new turns mid-callback', async () => {
    const activity = createBareActivity();
    activity._schedulingPaused = false;
    activity.newTurnsBlocked = false;
    activity._currentSpeech = undefined;
    // A handoff inside the user callback blocks new turns after guard A has already passed.
    const onUserTurnCompleted = vi.fn(async () => {
      activity.newTurnsBlocked = true;
    });
    const plainLlm = { id: 'plain-llm' };
    activity.agent = { llm: plainLlm, chatCtx: ChatContext.empty(), onUserTurnCompleted };
    activity.agentSession = { llm: undefined, _closing: false, _conversationItemAdded: vi.fn() };

    await (activity as any).userTurnCompleted(endOfTurnInfo);

    expect(onUserTurnCompleted).toHaveBeenCalledTimes(1);
    expect(activity.createSpeechTask).not.toHaveBeenCalled();
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

describe('cleanupReusableResources', () => {
  it('closes both STT pipeline and RT session', async () => {
    const sttClose = vi.fn(async () => {});
    const rtClose = vi.fn(async () => {});
    const resources: ReusableResources = {
      sttPipeline: { close: sttClose } as unknown as ReusableResources['sttPipeline'],
      rtSession: { close: rtClose } as unknown as ReusableResources['rtSession'],
    };

    await cleanupReusableResources(resources, log());

    expect(sttClose).toHaveBeenCalledTimes(1);
    expect(rtClose).toHaveBeenCalledTimes(1);
    expect(resources.sttPipeline).toBeUndefined();
    expect(resources.rtSession).toBeUndefined();
  });

  it('handles partial resources (only STT)', async () => {
    const sttClose = vi.fn(async () => {});
    const resources: ReusableResources = {
      sttPipeline: { close: sttClose } as unknown as ReusableResources['sttPipeline'],
    };

    await cleanupReusableResources(resources, log());

    expect(sttClose).toHaveBeenCalledTimes(1);
    expect(resources.sttPipeline).toBeUndefined();
  });

  it('handles empty resources', async () => {
    const resources: ReusableResources = {};
    await cleanupReusableResources(resources, log());
    // should not throw
  });
});
