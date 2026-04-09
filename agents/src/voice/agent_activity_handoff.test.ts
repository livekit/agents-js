// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { type RealtimeCapabilities, RealtimeModel, type RealtimeSession } from '../llm/realtime.js';
import type { SpeechEvent } from '../stt/stt.js';
import { Agent } from './agent.js';
import {
  AgentActivity,
  type ReusableResources,
  cleanupReusableResources,
} from './agent_activity.js';

type FakeActivity = {
  agent: Agent;
  audioRecognition: { detachSttPipeline: ReturnType<typeof vi.fn> } | undefined;
  stt: unknown;
  llm: unknown;
  tools: unknown;
  realtimeSession: unknown;
};

function createFakeActivity(agent: Agent, stt: unknown) {
  const detachedPipeline = { id: Symbol('pipeline') };
  const activity = {
    agent,
    audioRecognition: {
      detachSttPipeline: vi.fn(async () => detachedPipeline),
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
  return await (AgentActivity.prototype as any)._detachReusableResources.call(
    oldActivity,
    newActivity,
  );
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
      async sttNode(_audio: ReadableStream<AudioFrame>, _modelSettings: any) {
        return null as ReadableStream<SpeechEvent | string> | null;
      }
    }

    class AgentB extends Agent {
      async sttNode(_audio: ReadableStream<AudioFrame>, _modelSettings: any) {
        return null as ReadableStream<SpeechEvent | string> | null;
      }
    }

    const oldActivity = createFakeActivity(new AgentA({ instructions: 'a' }), sharedStt);
    const newActivity = createFakeActivity(new AgentB({ instructions: 'b' }), sharedStt);

    const resources = await detachResources(oldActivity.activity, newActivity.activity);

    expect(resources.sttPipeline).toBeUndefined();
    expect(oldActivity.activity.audioRecognition?.detachSttPipeline).not.toHaveBeenCalled();
  });

  it('reuses when the new agent inherits the same sttNode implementation', async () => {
    const sharedStt = { id: 'shared-stt' };

    class AgentA extends Agent {
      async sttNode(_audio: ReadableStream<AudioFrame>, _modelSettings: any) {
        return null as ReadableStream<SpeechEvent | string> | null;
      }
    }

    class AgentB extends AgentA {}

    const oldActivity = createFakeActivity(new AgentA({ instructions: 'a' }), sharedStt);
    const newActivity = createFakeActivity(new AgentB({ instructions: 'b' }), sharedStt);

    const resources = await detachResources(oldActivity.activity, newActivity.activity);

    expect(resources.sttPipeline).toBe(oldActivity.detachedPipeline);
    expect(oldActivity.activity.audioRecognition?.detachSttPipeline).toHaveBeenCalledTimes(1);
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

    const resources = await (AgentActivity.prototype as any)._detachReusableResources.call(
      oldActivity,
      newActivity,
    );

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

    const resources = await (AgentActivity.prototype as any)._detachReusableResources.call(
      oldActivity,
      newActivity,
    );

    expect(resources.rtSession).toBeUndefined();
  });

  it('does not reuse RT session when instructions differ and midSessionInstructionsUpdate is false', async () => {
    const sharedLlm = createFakeRealtimeModel({ midSessionInstructionsUpdate: false });
    const rtSession = createFakeRtSession();

    const oldActivity = createRtActivity(new Agent({ instructions: 'old' }), sharedLlm, rtSession);
    const newActivity = createRtActivity(new Agent({ instructions: 'new' }), sharedLlm);

    const resources = await (AgentActivity.prototype as any)._detachReusableResources.call(
      oldActivity,
      newActivity,
    );

    expect(resources.rtSession).toBeUndefined();
  });

  it('reuses RT session when instructions differ but midSessionInstructionsUpdate is true', async () => {
    const sharedLlm = createFakeRealtimeModel({ midSessionInstructionsUpdate: true });
    const rtSession = createFakeRtSession();

    const oldActivity = createRtActivity(new Agent({ instructions: 'old' }), sharedLlm, rtSession);
    const newActivity = createRtActivity(new Agent({ instructions: 'new' }), sharedLlm);

    const resources = await (AgentActivity.prototype as any)._detachReusableResources.call(
      oldActivity,
      newActivity,
    );

    expect(resources.rtSession).toBe(rtSession);
  });

  it('reuses RT session when context differs but midSessionChatCtxUpdate is true', async () => {
    const sharedLlm = createFakeRealtimeModel({ midSessionChatCtxUpdate: true });
    const rtSession = createFakeRtSession();
    // Give the session a non-empty chat context
    (rtSession as any).chatCtx = ChatContext.empty();

    const oldActivity = createRtActivity(new Agent({ instructions: 'same' }), sharedLlm, rtSession);
    const newActivity = createRtActivity(new Agent({ instructions: 'same' }), sharedLlm);

    const resources = await (AgentActivity.prototype as any)._detachReusableResources.call(
      oldActivity,
      newActivity,
    );

    expect(resources.rtSession).toBe(rtSession);
  });

  it('does not reuse when no RT session exists', async () => {
    const sharedLlm = createFakeRealtimeModel();
    const oldActivity = createRtActivity(new Agent({ instructions: 'a' }), sharedLlm, undefined);
    const newActivity = createRtActivity(new Agent({ instructions: 'a' }), sharedLlm);

    const resources = await (AgentActivity.prototype as any)._detachReusableResources.call(
      oldActivity,
      newActivity,
    );

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

    const resources = await (AgentActivity.prototype as any)._detachReusableResources.call(
      oldActivity,
      newActivity,
    );

    expect(resources.rtSession).toBeUndefined();
  });
});

describe('cleanupReusableResources', () => {
  it('closes both STT pipeline and RT session', async () => {
    const sttClose = vi.fn(async () => {});
    const rtClose = vi.fn(async () => {});
    const resources: ReusableResources = {
      sttPipeline: { close: sttClose } as any,
      rtSession: { close: rtClose } as any,
    };

    await cleanupReusableResources(resources);

    expect(sttClose).toHaveBeenCalledTimes(1);
    expect(rtClose).toHaveBeenCalledTimes(1);
    expect(resources.sttPipeline).toBeUndefined();
    expect(resources.rtSession).toBeUndefined();
  });

  it('handles partial resources (only STT)', async () => {
    const sttClose = vi.fn(async () => {});
    const resources: ReusableResources = {
      sttPipeline: { close: sttClose } as any,
    };

    await cleanupReusableResources(resources);

    expect(sttClose).toHaveBeenCalledTimes(1);
    expect(resources.sttPipeline).toBeUndefined();
  });

  it('handles empty resources', async () => {
    const resources: ReusableResources = {};
    await cleanupReusableResources(resources);
    // should not throw
  });
});
