// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import type { ChatContext } from '../llm/chat_context.js';
import { tool } from '../llm/tool_context.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { Future } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AudioRecognition } from './audio_recognition.js';
import { RUNNING_TOOL_PLACEHOLDER } from './generation.js';
import { AudioOutput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

type PostToolContextObservation = {
  canonicalHasToolOutput: boolean;
  preToolSnapshotIsEquivalent: boolean;
};

class ContextInspectingLLM extends FakeLLM {
  agent?: Agent;
  preToolContext?: ChatContext;
  readonly mhmmContexts: ChatContext[] = [];
  readonly postToolInference = new Future<PostToolContextObservation>();

  override chat(options: Parameters<FakeLLM['chat']>[0]) {
    if (
      options.chatCtx.items.some(
        (item) => item.type === 'message' && item.role === 'user' && item.textContent === 'Mhmm',
      )
    ) {
      this.mhmmContexts.push(options.chatCtx.copy());
    }

    const toolOutput = options.chatCtx.items.find(
      (item) => item.type === 'function_call_output' && item.output !== RUNNING_TOOL_PLACEHOLDER,
    );
    if (toolOutput && !this.postToolInference.done) {
      if (!this.agent || !this.preToolContext) {
        throw new Error('tool context snapshots were not initialized');
      }
      const canonicalContext = this.agent.chatCtx;
      this.postToolInference.resolve({
        canonicalHasToolOutput: canonicalContext.items.some(
          (item) => item.type === 'function_call_output' && item.callId === toolOutput.callId,
        ),
        preToolSnapshotIsEquivalent: this.preToolContext.isEquivalent(canonicalContext),
      });
    }
    return super.chat(options);
  }
}

class ImmediateOutput extends AudioOutput {
  constructor() {
    super(24_000);
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    const segmentCount = this.capturedPlayoutSegments;
    await super.captureFrame(frame);
    if (this.capturedPlayoutSegments > segmentCount) {
      this.onPlaybackStarted(Date.now());
    }
  }

  override flush(): void {
    super.flush();
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }

  override clearBuffer(): void {
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    }
  }
}

class FrameAgent extends Agent {
  constructor() {
    super({
      instructions: 'test',
      tools: {
        lookup: tool({
          description: 'Look up a value',
          execute: async () => 'forecast',
        }),
      },
    });
  }

  override async ttsNode(): Promise<ReadableStream<AudioFrame>> {
    return new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(new AudioFrame(new Int16Array(480), 24_000, 1, 480));
        controller.close();
      },
    });
  }
}

describe('AgentActivity tool output commit ordering', () => {
  it('ends active speech after entering the tool-call thinking state', async () => {
    const llm = new FakeLLM([
      {
        input: 'look it up',
        content: 'Let me check.',
        toolCalls: [{ name: 'lookup', args: {} }],
      },
      { input: '"forecast"', content: 'The forecast is clear.' },
    ]);
    const session = new AgentSession({ llm, stt: new FakeSTT() });
    session.output.audio = new ImmediateOutput();
    const speechEndStates: string[] = [];
    const onEndOfAgentSpeech = AudioRecognition.prototype.onEndOfAgentSpeech;
    const speechEndSpy = vi
      .spyOn(AudioRecognition.prototype, 'onEndOfAgentSpeech')
      .mockImplementation(async function (this: AudioRecognition, ignoreUntil: number) {
        speechEndStates.push(session.agentState);
        await onEndOfAgentSpeech.call(this, ignoreUntil);
      });

    await session.start({ agent: new FrameAgent() });
    try {
      const speech = session.generateReply({ userInput: 'look it up' });
      await speech.waitForPlayout();

      expect(speechEndStates[0]).toBe('thinking');
      expect(speechEndStates.slice(1).every((state) => state === 'listening')).toBe(true);
    } finally {
      speechEndSpy.mockRestore();
      await session.close();
    }
  });

  it('invalidates a stale preemptive generation when late EOU interrupts the post-tool reply', async () => {
    const llm = new ContextInspectingLLM([
      {
        input: 'find loads',
        toolCalls: [{ name: 'lookup_loads', args: {} }],
      },
      { input: 'Mhmm', content: 'Let me check.' },
      { input: '"no loads"', content: 'No loads were found.', duration: 1_000 },
    ]);
    const toolStarted = new Future<void>();
    const releaseTool = new Future<void>();
    const agent: Agent = new Agent({
      instructions: 'test',
      tools: {
        lookup_loads: tool({
          description: 'Look up available loads',
          execute: async () => {
            llm.preToolContext = agent.chatCtx.copy();
            toolStarted.resolve();
            await releaseTool.await;
            return 'no loads';
          },
        }),
      },
    });
    llm.agent = agent;

    const session = new AgentSession({ llm });
    session.output.setAudioEnabled(false);
    session.output.setTranscriptionEnabled(false);

    await session.start({ agent });
    try {
      const speech = session.generateReply({ userInput: 'find loads' });
      await toolStarted.await;

      const activity = session._activity as unknown as {
        _currentSpeech?: unknown;
        onPreemptiveGeneration: (info: {
          newTranscript: string;
          transcriptConfidence: number;
          startedSpeakingAt?: number;
        }) => void;
        userTurnCompleted: (info: {
          newTranscript: string;
          transcriptConfidence: number;
          skipReply: boolean;
        }) => Promise<void>;
      };
      await vi.waitFor(() => expect(activity._currentSpeech).toBeUndefined());
      activity.onPreemptiveGeneration({
        newTranscript: 'Mhmm',
        transcriptConfidence: 0.9,
      });
      await vi.waitFor(() => expect(llm.mhmmContexts).toHaveLength(1));

      releaseTool.resolve();
      const observation = await llm.postToolInference.await;

      expect(llm.preToolContext?.items.some((item) => item.type === 'function_call')).toBe(true);
      expect(observation.canonicalHasToolOutput).toBe(true);
      expect(observation.preToolSnapshotIsEquivalent).toBe(false);

      await vi.waitFor(() => expect(activity._currentSpeech).toBeDefined());
      await activity.userTurnCompleted({
        newTranscript: 'Mhmm',
        transcriptConfidence: 0.9,
        skipReply: false,
      });
      await vi.waitFor(() => expect(llm.mhmmContexts).toHaveLength(2));

      const staleOutput = llm.mhmmContexts[0]!.items.find(
        (item) => item.type === 'function_call_output',
      );
      const regeneratedOutput = llm.mhmmContexts[1]!.items.find(
        (item) => item.type === 'function_call_output',
      );
      expect(staleOutput?.output).toBe(RUNNING_TOOL_PLACEHOLDER);
      expect(regeneratedOutput?.output).toBe('"no loads"');

      await speech.waitForPlayout();

      const toolCall = agent.chatCtx.items.find((item) => item.type === 'function_call');
      const toolOutputs = agent.chatCtx.items.filter(
        (item) => item.type === 'function_call_output' && item.callId === toolCall?.callId,
      );
      expect(toolCall).toBeDefined();
      expect(toolOutputs).toHaveLength(1);
      expect(agent.chatCtx.items.indexOf(toolOutputs[0]!)).toBeGreaterThan(
        agent.chatCtx.items.indexOf(toolCall!),
      );
    } finally {
      await session.close();
    }
  });
});
