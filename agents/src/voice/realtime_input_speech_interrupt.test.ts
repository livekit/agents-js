// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import {
  ChatContext,
  type RealtimeCapabilities,
  RealtimeModel,
  RealtimeSession,
  type ToolChoice,
  ToolContext,
} from '../llm/index.js';
import * as logModule from '../log.js';
import type { VADStream } from '../vad.js';
import { VAD } from '../vad.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import { SpeechHandle } from './speech_handle.js';

class FakeVAD extends VAD {
  label = 'FakeVAD';

  constructor() {
    super({ updateInterval: 32 });
  }

  stream(): VADStream {
    throw new Error('not used in this test');
  }
}

class FakeRealtimeSession extends RealtimeSession {
  readonly chatCtx = ChatContext.empty();
  readonly tools = ToolContext.empty();

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
  get model() {
    return 'fake-realtime';
  }

  session(): RealtimeSession {
    return new FakeRealtimeSession(this);
  }

  async close() {}
}

function fakeCapabilities(turnDetection: boolean): RealtimeCapabilities {
  return {
    messageTruncation: false,
    turnDetection,
    userTranscription: false,
    autoToolReplyGeneration: false,
    audioOutput: true,
    manualFunctionCalls: false,
    midSessionChatCtxUpdate: false,
    midSessionInstructionsUpdate: false,
    midSessionToolsUpdate: false,
    canDisableTurnDetection: false,
  };
}

type ActivityInternals = {
  rtTurnDetectionEnabled: boolean;
  _currentSpeech?: SpeechHandle;
  realtimeSession?: { interrupt: ReturnType<typeof vi.fn> };
};

function activity(serverTurnDetection: boolean, allowInterruptions = true): AgentActivity {
  const session = new AgentSession({
    llm: new FakeRealtimeModel(fakeCapabilities(serverTurnDetection)),
    vad: new FakeVAD(),
    turnHandling: { interruption: { enabled: allowInterruptions } },
  });
  return new AgentActivity(new Agent({ instructions: 'test' }), session);
}

function speechStarted(
  activity: AgentActivity,
  allowInterruptions: boolean,
): { handle: SpeechHandle; interrupt: ReturnType<typeof vi.fn> } {
  const internals = activity as unknown as ActivityInternals;
  const handle = SpeechHandle.create({ allowInterruptions });
  const interrupt = vi.fn();
  internals._currentSpeech = handle;
  internals.realtimeSession = { interrupt };
  activity.onInputSpeechStarted({});
  return { handle, interrupt };
}

describe('realtime input speech interruption', () => {
  it('warns when interruptions are disabled with server turn detection', () => {
    const warn = vi.spyOn(logModule.log(), 'warn').mockImplementation(() => undefined);

    const result = activity(true, false) as unknown as ActivityInternals;

    expect(result.rtTurnDetectionEnabled).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('allowInterruptions cannot be false'),
    );
  });

  it('allows interruptions to be disabled with client-side turn taking', () => {
    const result = activity(false, false) as unknown as ActivityInternals;

    expect(result.rtTurnDetectionEnabled).toBe(false);
  });

  it('keeps uninterruptible speech when input speech starts', () => {
    const error = vi.spyOn(logModule.log(), 'error').mockImplementation(() => undefined);
    const result = activity(false, false);

    const { handle, interrupt } = speechStarted(result, false);

    expect(handle.interrupted).toBe(false);
    expect(interrupt).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('interrupts interruptible speech when input speech starts', () => {
    const result = activity(true);

    const { handle, interrupt } = speechStarted(result, true);

    expect(handle.interrupted).toBe(true);
    expect(interrupt).toHaveBeenCalledOnce();
  });
});
