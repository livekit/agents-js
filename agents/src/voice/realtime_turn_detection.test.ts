// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { TurnDetector } from '../inference/eot/detector.js';
import { type RealtimeCapabilities, RealtimeModel, type RealtimeSession } from '../llm/realtime.js';
import type { VADStream } from '../vad.js';
import { VAD as BaseVAD } from '../vad.js';
import { Agent, type AgentOptions } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';

class FakeVAD extends BaseVAD {
  label = 'FakeVAD';

  constructor() {
    super({ updateInterval: 32 });
  }

  stream(): VADStream {
    throw new Error('not used in this test');
  }
}

class FakeRealtimeModel extends RealtimeModel {
  get model() {
    return 'fake-realtime';
  }

  session(): RealtimeSession {
    throw new Error('not used in this test');
  }

  async close() {}
}

function serverTurnModel(): FakeRealtimeModel {
  const capabilities: RealtimeCapabilities = {
    messageTruncation: false,
    turnDetection: true,
    canDisableTurnDetection: true,
    userTranscription: false,
    autoToolReplyGeneration: false,
    audioOutput: true,
    manualFunctionCalls: false,
    midSessionChatCtxUpdate: true,
    midSessionInstructionsUpdate: true,
    midSessionToolsUpdate: true,
  };
  return new FakeRealtimeModel(capabilities);
}

type ActivityInternals = {
  rtTurnDetectionEnabled: boolean;
  realtimeSession?: unknown;
  logger: { warn: (...args: unknown[]) => void };
};

function activity(
  session: AgentSession,
  agentOptions: Partial<AgentOptions<unknown>> = {},
): AgentActivity & ActivityInternals {
  return new AgentActivity(
    new Agent({ instructions: 'test', ...agentOptions }),
    session,
  ) as unknown as AgentActivity & ActivityInternals;
}

describe('realtime server-side turn detection', () => {
  it.each([
    ['a user VAD with the default detector keeps it on', { vad: new FakeVAD() }, true],
    [
      'an explicit TurnDetector with a VAD hands turns to the client',
      { vad: new FakeVAD(), turnHandling: { turnDetection: new TurnDetector() } },
      false,
    ],
    [
      'vad mode with a VAD hands turns to the client',
      { vad: new FakeVAD(), turnHandling: { turnDetection: 'vad' as const } },
      false,
    ],
    [
      'vad mode without a VAD keeps it on',
      { vad: null, turnHandling: { turnDetection: 'vad' as const } },
      true,
    ],
    [
      'manual turns it off',
      { vad: null, turnHandling: { turnDetection: 'manual' as const } },
      false,
    ],
  ])('%s', (_name, options, enabled) => {
    const session = new AgentSession({ llm: serverTurnModel(), ...options });
    expect(activity(session).rtTurnDetectionEnabled).toBe(enabled);
  });

  it("lets the agent's choice override the session's", () => {
    const session = new AgentSession({
      llm: serverTurnModel(),
      vad: new FakeVAD(),
      turnHandling: { turnDetection: 'vad' },
    });
    const agent = activity(session, { turnHandling: { turnDetection: 'realtime_llm' } });
    expect(agent.rtTurnDetectionEnabled).toBe(true);
  });

  it('reuses a realtime session on handoff only when the setting matches', async () => {
    const session = new AgentSession({ llm: serverTurnModel(), vad: null });
    const manual = activity(session, { turnHandling: { turnDetection: 'manual' } });
    const rtSession = { off: vi.fn() };
    manual.realtimeSession = rtSession;

    const serverTurns = activity(session);
    expect((await manual._detachReusableResources(serverTurns)).rtSession).toBeUndefined();

    const alsoManual = activity(session, { turnHandling: { turnDetection: 'manual' } });
    expect((await manual._detachReusableResources(alsoManual)).rtSession).toBe(rtSession);
  });

  it('warns when a runtime change would flip it', () => {
    const session = new AgentSession({ llm: serverTurnModel(), vad: new FakeVAD() });
    const current = activity(session);
    const warn = vi.spyOn(current.logger, 'warn');

    session.updateOptions({ turnHandling: { turnDetection: 'realtime_llm' } });
    current.updateOptions({ turnDetection: 'realtime_llm' });
    expect(warn).not.toHaveBeenCalled();

    session.updateOptions({ turnHandling: { turnDetection: 'manual' } });
    current.updateOptions({ turnDetection: 'manual' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('it stays enabled'));
  });
});
