// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { InferenceExecutor } from '../ipc/inference_executor.js';
import {
  JobContext,
  type JobProcess,
  type RunningJobInfo,
  runWithJobContext,
  runWithJobContextAsync,
} from '../job.js';
import type { LLM } from '../llm/index.js';
import { initializeLogger } from '../log.js';
import type { STT } from '../stt/index.js';
import type { TTS } from '../tts/index.js';
import type { VAD } from '../vad.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';

beforeAll(() => {
  initializeLogger({ pretty: true, level: 'silent' });
});

/** `undefined` → no dispatch attribute at all; `null` → dispatch present but
 * without a mode key; a string sets the mode. */
function jobCtxWithMode(mode?: string | null): JobContext {
  const room = {
    name: 'room',
    on: () => room,
    off: () => room,
    isConnected: false,
    remoteParticipants: new Map(),
  };
  const attributes: Record<string, string> = {};
  if (mode !== undefined) {
    const payload: Record<string, unknown> = {
      simulationRunId: 'SR_1',
      scenario: { label: 's' },
    };
    if (mode !== null) {
      payload.mode = mode;
    }
    attributes['lk.simulator.dispatch'] = JSON.stringify(payload);
  }
  return new JobContext(
    {} as unknown as JobProcess,
    {
      acceptArguments: { name: 'agent', identity: 'agent', metadata: '' },
      job: { id: 'job-id', room: { name: 'room' }, attributes },
      url: 'wss://example.livekit.cloud',
      token: 'token',
      workerId: 'worker-id',
    } as unknown as RunningJobInfo,
    room as unknown as Room,
    () => {},
    () => {},
    {} as unknown as InferenceExecutor,
  );
}

const fakeStt = { label: 'fake-stt' } as unknown as STT;
const fakeTts = { label: 'fake-tts' } as unknown as TTS;
const fakeVad = { label: 'fake-vad' } as unknown as VAD;
const fakeLlm = { label: 'fake-llm' } as unknown as LLM;

const newSession = () =>
  new AgentSession({
    stt: fakeStt,
    tts: fakeTts,
    vad: fakeVad,
    llm: fakeLlm,
    turnDetection: 'manual',
  });

describe('AgentSession text-only gating', () => {
  it('resolves text mode when an activity is created after the session', () => {
    const session = newSession();
    expect(session._textOnly).toBe(false);

    runWithJobContext(jobCtxWithMode('SIMULATION_MODE_TEXT'), () => {
      const activity = new AgentActivity(new Agent({ instructions: 'help the user' }), session);
      expect(session._textOnly).toBe(true);
      expect(activity.stt).toBeUndefined();
      expect(activity.tts).toBeUndefined();
      expect(activity.vad).toBeUndefined();
    });
  });

  it('drops STT/TTS/VAD under a TEXT simulation', () => {
    runWithJobContext(jobCtxWithMode('SIMULATION_MODE_TEXT'), () => {
      const session = newSession();
      const activity = new AgentActivity(new Agent({ instructions: 'help the user' }), session);
      expect(session._textOnly).toBe(true);
      expect(activity.stt).toBeUndefined();
      expect(activity.tts).toBeUndefined();
      expect(activity.vad).toBeUndefined();
    });
  });

  it('treats a dispatch without mode as text', () => {
    runWithJobContext(jobCtxWithMode(null), () => {
      const session = newSession();
      const activity = new AgentActivity(new Agent({ instructions: 'help the user' }), session);
      expect(session._textOnly).toBe(true);
      expect(activity.stt).toBeUndefined();
    });
  });

  it('keeps components under an AUDIO simulation', () => {
    const session = runWithJobContext(jobCtxWithMode('SIMULATION_MODE_AUDIO'), newSession);
    expect(session._textOnly).toBe(false);
    expect(session.stt).toBe(fakeStt);
    expect(session.tts).toBe(fakeTts);
    expect(session.vad).toBe(fakeVad);
  });

  it('keeps components outside a simulation', () => {
    const session = newSession();
    expect(session._textOnly).toBe(false);
    expect(session.stt).toBe(fakeStt);
  });

  it('explicitly disables audio recording for text simulations', async () => {
    const ctx = jobCtxWithMode('SIMULATION_MODE_TEXT');
    const initRecording = vi.spyOn(ctx, 'initRecording').mockResolvedValue();
    const session = newSession();

    await runWithJobContextAsync(ctx, async () => {
      await session.start({
        agent: new Agent({ instructions: 'help the user' }),
        record: true,
      });
    });

    expect(session._recordingOptions).toEqual({
      audio: false,
      traces: true,
      logs: true,
      transcript: true,
      redaction: false,
    });
    expect(initRecording).toHaveBeenCalledWith(session._recordingOptions);
    await session.close();
  });
});
