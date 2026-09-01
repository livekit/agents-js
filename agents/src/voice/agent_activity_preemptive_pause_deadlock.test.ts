// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { ChatContext } from '../llm/chat_context.js';
import { type ChatChunk, LLM, LLMStream } from '../llm/llm.js';
import type { ToolChoice, ToolContextLike } from '../llm/tool_context.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Future } from '../utils.js';
import { Agent } from './agent.js';
import type { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import type { EndOfTurnInfo, PreemptiveGenerationInfo } from './audio_recognition.js';
import { SpeechHandle } from './speech_handle.js';

const TIMEOUT = 2_000;

class GatedStream extends LLMStream {
  constructor(
    llm: LLM,
    options: {
      chatCtx: ChatContext;
      toolCtx?: ToolContextLike;
      connOptions: APIConnectOptions;
      gate: Future<void>;
    },
  ) {
    super(llm, options);
    this.gate = options.gate;
  }

  private readonly gate: Future<void>;

  protected override async run(): Promise<void> {
    this.queue.put({
      id: 'chunk',
      delta: { role: 'assistant', content: 'one moment' },
    } satisfies ChatChunk);
    await this.gate.await;
  }
}

class GatedLLM extends LLM {
  private readonly gate = new Future<void>();

  override get model(): string {
    return 'gated';
  }

  override get provider(): string {
    return 'test';
  }

  override label(): string {
    return 'test.GatedLLM';
  }

  release(): void {
    this.gate.resolve();
  }

  override chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    return new GatedStream(this, { chatCtx, toolCtx, connOptions, gate: this.gate });
  }
}

type ActivityInternals = AgentActivity & {
  _currentSpeech?: SpeechHandle;
  _preemptiveGeneration?: unknown;
  _userTurnCompletedTask?: { done: boolean };
};

function endOfTurn(newTranscript: string): EndOfTurnInfo {
  return {
    skipReply: false,
    newTranscript,
    transcriptConfidence: 1,
    transcriptionDelay: 0,
    endOfUtteranceDelay: 0,
    startedSpeakingAt: undefined,
    stoppedSpeakingAt: undefined,
  };
}

async function startSession(): Promise<{
  llm: GatedLLM;
  session: AgentSession;
  activity: ActivityInternals;
}> {
  const llm = new GatedLLM();
  const session = new AgentSession({ llm });
  session.output.setAudioEnabled(false);
  await session.start({ agent: new Agent({ instructions: 'qualify the caller' }) });
  return { llm, session, activity: session._activity! as ActivityInternals };
}

function startPreemptiveGeneration(activity: ActivityInternals): void {
  activity.onPreemptiveGeneration({
    newTranscript: 'what is the rate',
    transcriptConfidence: 1,
    startedSpeakingAt: Date.now(),
  } satisfies PreemptiveGenerationInfo);
}

describe('AgentActivity parked preemptive generation', () => {
  it('does not hang a handoff after a turn is discarded for uninterruptible speech', async () => {
    const { llm, session, activity } = await startSession();

    try {
      expect(session.currentSpeech).toBeUndefined();
      startPreemptiveGeneration(activity);
      expect(activity._preemptiveGeneration).toBeDefined();

      const holdSpeech = SpeechHandle.create({ allowInterruptions: false });
      activity._currentSpeech = holdSpeech;

      await activity.onEndOfTurn(endOfTurn('can you tell me the rate'));
      await vi.waitFor(() => expect(activity._userTurnCompletedTask?.done).toBe(true), {
        timeout: TIMEOUT,
      });

      holdSpeech._markDone();
      activity._currentSpeech = undefined;

      await session._updateActivity(new Agent({ instructions: 'hand off' }), {
        previousActivity: 'pause',
        blockedTasks: [],
        waitOnEnter: false,
      });
      expect(activity._preemptiveGeneration).toBeUndefined();
    } finally {
      llm.release();
      await session.close().catch(() => {});
    }
  });

  it('clears a parked preemptive reply before waiting for speech tasks', async () => {
    const { llm, session, activity } = await startSession();

    try {
      startPreemptiveGeneration(activity);
      expect(activity._preemptiveGeneration).toBeDefined();

      await session._updateActivity(new Agent({ instructions: 'hand off' }), {
        previousActivity: 'pause',
        blockedTasks: [],
        waitOnEnter: false,
      });

      expect(activity._preemptiveGeneration).toBeUndefined();
    } finally {
      llm.release();
      await session.close().catch(() => {});
    }
  });

  it('does not let a reply parked while pausing block the handoff', async () => {
    const llm = new GatedLLM();
    const session = new AgentSession({ llm });
    session.output.setAudioEnabled(false);

    class TalkingExit extends Agent {
      constructor() {
        super({ instructions: 'qualify the caller' });
      }

      override async onExit(): Promise<void> {
        const activity = session._activity! as ActivityInternals;
        startPreemptiveGeneration(activity);
        expect(activity._preemptiveGeneration).toBeDefined();
      }
    }

    await session.start({ agent: new TalkingExit() });
    const activity = session._activity! as ActivityInternals;

    try {
      await session._updateActivity(new Agent({ instructions: 'hand off' }), {
        waitOnEnter: false,
      });
      expect(activity._preemptiveGeneration).toBeUndefined();
    } finally {
      llm.release();
      await session.close().catch(() => {});
    }
  });
});
