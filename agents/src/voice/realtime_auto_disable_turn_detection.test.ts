// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { BaseStreamingTurnDetector } from '../inference/eot/base.js';
import {
  ChatContext,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
  type RealtimeSessionOptions,
  type ToolChoice,
  ToolContext,
} from '../llm/index.js';
import * as logModule from '../log.js';
import type { VADStream } from '../vad.js';
import { VAD as BaseVAD } from '../vad.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession, type TurnDetectionMode } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

class FakeVAD extends BaseVAD {
  label = 'FakeVAD';

  constructor() {
    super({ updateInterval: 32 });
  }

  stream(): VADStream {
    throw new Error('not used in this test');
  }
}

class FakeTurnDetector extends BaseStreamingTurnDetector {
  get model() {
    return 'turn-detector-v1-mini' as const;
  }

  constructor() {
    super({
      sampleRate: 16000,
      thresholds: {
        thresholds: {},
        lookup: async () => undefined,
        lookupBackchannel: async () => undefined,
        supports: async () => true,
      },
    });
  }

  stream() {
    throw new Error('not used in this test');
  }
}

class FakeRealtimeSession extends RealtimeSession {
  readonly turnDetectionDisabled: boolean;
  readonly chatCtx = ChatContext.empty();
  readonly tools = ToolContext.empty();

  constructor(model: RealtimeModel, options: RealtimeSessionOptions = {}) {
    super(model);
    this.turnDetectionDisabled = options.turnDetectionDisabled ?? false;
  }

  async updateInstructions() {}
  async updateChatCtx() {}
  async updateTools() {}
  updateOptions(_options: { toolChoice?: ToolChoice | null }) {}
  pushAudio() {}
  async generateReply() {
    throw new Error('not used in this test');
  }
  async commitAudio() {}
  async clearAudio() {}
  async interrupt() {}
  async truncate() {}
}

class FakeRealtimeModel extends RealtimeModel {
  readonly createdSessions: FakeRealtimeSession[] = [];

  get model() {
    return 'fake-realtime';
  }

  session(options: RealtimeSessionOptions = {}): RealtimeSession {
    const session = new FakeRealtimeSession(this, options);
    this.createdSessions.push(session);
    return session;
  }

  async close() {}
}

function fakeCapabilities(overrides: Partial<RealtimeCapabilities> = {}): RealtimeCapabilities {
  return {
    messageTruncation: false,
    turnDetection: true,
    userTranscription: false,
    autoToolReplyGeneration: false,
    audioOutput: true,
    manualFunctionCalls: false,
    midSessionChatCtxUpdate: false,
    midSessionInstructionsUpdate: false,
    midSessionToolsUpdate: false,
    canDisableTurnDetection: false,
    ...overrides,
  };
}

function makeActivity(session: AgentSession, agent = new Agent({ instructions: 'test' })) {
  return new AgentActivity(agent, session) as unknown as {
    rtTurnDetectionEnabled: boolean;
    turnDetectionMode?: TurnDetectionMode;
    _resolvedTurnDetection?: TurnDetectionMode;
    _detachReusableResources: (
      newActivity: AgentActivity,
    ) => Promise<{ rtSession?: RealtimeSession }>;
  };
}

function realtimeSession(
  options: {
    capabilities?: Partial<RealtimeCapabilities>;
    vad?: BaseVAD | null;
    turnDetection?: TurnDetectionMode | null;
    interruptionMode?: 'adaptive' | 'vad';
  } = {},
) {
  const model = new FakeRealtimeModel(
    fakeCapabilities({ canDisableTurnDetection: true, ...options.capabilities }),
  );
  const turnHandling: ConstructorParameters<typeof AgentSession>[0]['turnHandling'] = {};
  if (options.turnDetection !== undefined) {
    turnHandling.turnDetection = options.turnDetection;
  }
  if (options.interruptionMode !== undefined) {
    turnHandling.interruption = { mode: options.interruptionMode };
  }
  return {
    model,
    session: new AgentSession({
      llm: model,
      vad: options.vad === undefined ? new FakeVAD() : options.vad,
      turnHandling,
    }),
  };
}

function updateTurnDetection(
  session: AgentSession,
  activity: AgentActivity,
  turnDetection: TurnDetectionMode | null,
) {
  Object.defineProperty(session, 'activity', {
    configurable: true,
    value: activity,
    writable: true,
  });
  session.updateOptions({ turnDetection });
}

describe('realtime auto-disable turn detection', () => {
  it('turn detector disables server-side turn detection', () => {
    const { session } = realtimeSession({ turnDetection: new FakeTurnDetector() });
    expect(makeActivity(session).rtTurnDetectionEnabled).toBe(false);
  });

  it('vad mode disables server-side turn detection', () => {
    const { session } = realtimeSession({ turnDetection: 'vad' });
    expect(makeActivity(session).rtTurnDetectionEnabled).toBe(false);
  });

  it('adaptive interruption alone disables server-side turn detection', () => {
    const { session } = realtimeSession({ interruptionMode: 'adaptive' });
    expect(makeActivity(session).rtTurnDetectionEnabled).toBe(false);
  });

  it('manual disables server-side turn detection without VAD', () => {
    const { session } = realtimeSession({ vad: null, turnDetection: 'manual' });
    expect(makeActivity(session).rtTurnDetectionEnabled).toBe(false);
  });

  it('vad interruption disables server-side turn detection', () => {
    const { session } = realtimeSession({ interruptionMode: 'vad' });
    expect(makeActivity(session).rtTurnDetectionEnabled).toBe(false);
  });

  it('stt mode keeps server-side turn detection', () => {
    const { session } = realtimeSession({ turnDetection: 'stt' });
    expect(makeActivity(session).rtTurnDetectionEnabled).toBe(true);
  });

  it('conflict keeps server-side turn detection', () => {
    const { session } = realtimeSession({
      capabilities: { canDisableTurnDetection: false },
      turnDetection: 'vad',
    });
    expect(makeActivity(session).rtTurnDetectionEnabled).toBe(true);
  });

  it('explicit off on model is already off', () => {
    const { session } = realtimeSession({
      capabilities: { turnDetection: false, canDisableTurnDetection: false },
      turnDetection: 'vad',
    });
    expect(makeActivity(session).rtTurnDetectionEnabled).toBe(false);
  });

  it('no client trigger keeps server-side turn detection', () => {
    const { session } = realtimeSession();
    expect(makeActivity(session).rtTurnDetectionEnabled).toBe(true);
  });

  it('realtime_llm mode is not a disable trigger', () => {
    const { session } = realtimeSession({ turnDetection: 'realtime_llm' });
    expect(makeActivity(session).rtTurnDetectionEnabled).toBe(true);
  });

  it('no VAD does not disable vad mode into a no-turn-detection state', () => {
    const { session } = realtimeSession({ vad: null, turnDetection: 'vad' });
    expect(makeActivity(session).rtTurnDetectionEnabled).toBe(true);
  });

  it('non-realtime LLM reports no server-side turn detection', () => {
    const session = new AgentSession({
      llm: new FakeLLM(),
      vad: new FakeVAD(),
      turnHandling: { turnDetection: 'vad' },
    });
    expect(makeActivity(session).rtTurnDetectionEnabled).toBe(false);
  });

  it('passes the disable flag when starting a realtime session', async () => {
    const { model, session } = realtimeSession({ turnDetection: 'vad' });
    await (makeActivity(session) as unknown as AgentActivity).start();
    expect(model.createdSessions.at(-1)?.turnDetectionDisabled).toBe(true);
  });

  it('warns when a runtime change would flip resolved server-side turn detection', () => {
    const warn = vi.fn();
    vi.spyOn(logModule.log(), 'warn').mockImplementation(warn);
    const { session } = realtimeSession();
    const activity = makeActivity(session) as unknown as AgentActivity;

    updateTurnDetection(session, activity, 'manual');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('it stays enabled for this session'));
  });

  it('does not warn when reverting runtime turn detection to automatic', () => {
    const warn = vi.fn();
    vi.spyOn(logModule.log(), 'warn').mockImplementation(warn);
    const { session } = realtimeSession({ turnDetection: 'vad' });
    const activity = makeActivity(session) as unknown as AgentActivity;

    updateTurnDetection(session, activity, null);

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('resolved at session start'));
  });

  it('does not warn when server-side turn detection state is unchanged', () => {
    const warn = vi.fn();
    vi.spyOn(logModule.log(), 'warn').mockImplementation(warn);
    const { session } = realtimeSession({ turnDetection: 'vad' });
    const activity = makeActivity(session) as unknown as AgentActivity;

    updateTurnDetection(session, activity, 'manual');

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('resolved at session start'));
  });

  it('supersedes the default turn detector silently', () => {
    const warn = vi.fn();
    vi.spyOn(logModule.log(), 'warn').mockImplementation(warn);
    const { session } = realtimeSession();
    const activity = makeActivity(session);

    expect(activity.rtTurnDetectionEnabled).toBe(true);
    expect(activity._resolvedTurnDetection).toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('ignoring the turnDetection setting'),
    );
  });

  it('warns for an explicit turn detector when the model keeps server-side turn detection', () => {
    const warn = vi.fn();
    vi.spyOn(logModule.log(), 'warn').mockImplementation(warn);
    const { session } = realtimeSession({
      capabilities: { canDisableTurnDetection: false },
      turnDetection: new FakeTurnDetector(),
    });

    makeActivity(session);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ignoring the turnDetection setting'),
    );
  });

  it('does not reuse realtime sessions when turn detection resolution differs', async () => {
    const model = new FakeRealtimeModel(
      fakeCapabilities({ canDisableTurnDetection: true, midSessionChatCtxUpdate: true }),
    );
    const serverOnSession = new AgentSession({ llm: model, vad: new FakeVAD() });
    const clientSession = new AgentSession({
      llm: model,
      vad: new FakeVAD(),
      turnHandling: { turnDetection: 'vad' },
    });
    const serverOn = makeActivity(serverOnSession);
    const client = makeActivity(clientSession) as unknown as AgentActivity;
    Object.defineProperty(serverOn, 'realtimeSession', {
      configurable: true,
      value: model.session(),
      writable: true,
    });

    const resources = await serverOn._detachReusableResources(client);

    expect(resources.rtSession).toBeUndefined();
  });
});
