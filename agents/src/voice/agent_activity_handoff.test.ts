// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { type SpeechEvent } from '../stt/stt.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';

type FakeActivity = {
  agent: Agent;
  audioRecognition: { detachSttPipeline: ReturnType<typeof vi.fn> } | undefined;
  stt: unknown;
};

function createFakeActivity(agent: Agent, stt: unknown) {
  const detachedPipeline = { id: Symbol('pipeline') };
  const activity = {
    agent,
    audioRecognition: {
      detachSttPipeline: vi.fn(async () => detachedPipeline),
    },
    stt,
  } as FakeActivity;

  return { activity, detachedPipeline };
}

async function detachIfReusable(oldActivity: FakeActivity, newActivity: FakeActivity) {
  return await (AgentActivity.prototype as any)._detachSttPipelineIfReusable.call(
    oldActivity,
    newActivity,
  );
}

describe('AgentActivity STT handoff reuse eligibility', () => {
  it('reuses the pipeline when both activities share the same STT instance and sttNode', async () => {
    const sharedStt = { id: 'shared-stt' };
    const oldActivity = createFakeActivity(new Agent({ instructions: 'a' }), sharedStt);
    const newActivity = createFakeActivity(new Agent({ instructions: 'b' }), sharedStt);

    const result = await detachIfReusable(oldActivity.activity, newActivity.activity);

    expect(result).toBe(oldActivity.detachedPipeline);
    expect(oldActivity.activity.audioRecognition?.detachSttPipeline).toHaveBeenCalledTimes(1);
  });

  it('does not reuse when the STT instances differ', async () => {
    const oldActivity = createFakeActivity(new Agent({ instructions: 'a' }), { id: 'stt-a' });
    const newActivity = createFakeActivity(new Agent({ instructions: 'b' }), { id: 'stt-b' });

    const result = await detachIfReusable(oldActivity.activity, newActivity.activity);

    expect(result).toBeUndefined();
    expect(oldActivity.activity.audioRecognition?.detachSttPipeline).not.toHaveBeenCalled();
  });

  it('does not reuse when either activity has no STT', async () => {
    const sharedStt = { id: 'shared-stt' };
    const oldActivity = createFakeActivity(new Agent({ instructions: 'a' }), undefined);
    const newActivity = createFakeActivity(new Agent({ instructions: 'b' }), sharedStt);

    const result = await detachIfReusable(oldActivity.activity, newActivity.activity);

    expect(result).toBeUndefined();
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

    const result = await detachIfReusable(oldActivity.activity, newActivity.activity);

    expect(result).toBeUndefined();
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

    const result = await detachIfReusable(oldActivity.activity, newActivity.activity);

    expect(result).toBe(oldActivity.detachedPipeline);
    expect(oldActivity.activity.audioRecognition?.detachSttPipeline).toHaveBeenCalledTimes(1);
  });

  it('does not reuse when the old activity has no audioRecognition', async () => {
    const sharedStt = { id: 'shared-stt' };
    const oldActivity = createFakeActivity(new Agent({ instructions: 'a' }), sharedStt);
    const newActivity = createFakeActivity(new Agent({ instructions: 'b' }), sharedStt);
    oldActivity.activity.audioRecognition = undefined;

    const result = await detachIfReusable(oldActivity.activity, newActivity.activity);

    expect(result).toBeUndefined();
  });
});
