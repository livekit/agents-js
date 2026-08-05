// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import type { ChatContext } from '../llm/chat_context.js';
import type { ChatChunk } from '../llm/llm.js';
import type { ToolContext } from '../llm/tool_context.js';
import { type ChunkedStream, SynthesizeStream, TTS } from '../tts/tts.js';
import type { APIConnectOptions, FlushSentinel } from '../types.js';
import { Agent, type ModelSettings } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type ConversationItemAddedEvent } from './events.js';
import { AudioOutput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

class DelayedSentenceStream extends SynthesizeStream {
  label = 'test.DelayedSentenceStream';

  protected async run(): Promise<void> {
    for await (const data of this.input) {
      if (this.abortSignal.aborted) return;
      if (data === SynthesizeStream.FLUSH_SENTINEL) continue;
    }
    this.markStarted();
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.queue.put({
      requestId: 'test-request',
      frame: new AudioFrame(new Int16Array(480), 24_000, 1, 480),
      final: true,
    });
  }
}

class DelayedSentenceTTS extends TTS {
  label = 'test.DelayedSentenceTTS';

  constructor() {
    super(24_000, 1, { streaming: true });
  }

  synthesize(_text: string, _connOptions?: APIConnectOptions): ChunkedStream {
    throw new Error('chunked synthesis is not used by this test');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new DelayedSentenceStream(this, options?.connOptions);
  }
}

class DelayedSentenceAgent extends Agent {
  constructor() {
    super({ instructions: 'test' });
  }

  async llmNode(
    _chatCtx: ChatContext,
    _toolCtx: ToolContext,
    _modelSettings: ModelSettings,
  ): Promise<ReadableStream<ChatChunk | string | FlushSentinel>> {
    return new ReadableStream({
      async start(controller) {
        controller.enqueue("I'm doing well, ");
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.enqueue('thank you!');
        controller.close();
      },
    });
  }
}

class ImmediateAudioOutput extends AudioOutput {
  private started = false;

  constructor() {
    super(24_000);
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);
    if (!this.started) {
      this.started = true;
      this.onPlaybackStarted(Date.now());
    }
  }

  override flush(): void {
    super.flush();
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }

  clearBuffer(): void {}
}

describe('AgentSession LLM node metrics', () => {
  it('anchors TTFS on synthesis start', async () => {
    const session = new AgentSession({ llm: new FakeLLM(), tts: new DelayedSentenceTTS() });
    session.output.audio = new ImmediateAudioOutput();
    const assistantMessages: ConversationItemAddedEvent[] = [];
    session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => {
      if (event.item.type === 'message' && event.item.role === 'assistant') {
        assistantMessages.push(event);
      }
    });

    await session.start({ agent: new DelayedSentenceAgent() });
    try {
      const handle = session.generateReply({ userInput: 'Hello, how are you?' });
      await handle.waitForPlayout();
      await vi.waitFor(() => expect(assistantMessages).toHaveLength(1));

      const item = assistantMessages[0]!.item;
      if (item.type !== 'message') throw new Error('expected assistant message');
      expect(item.metrics.llmNodeTtfs).toBeGreaterThanOrEqual(0.09);
      expect(item.metrics.ttsNodeTtfb).toBeGreaterThanOrEqual(0.015);
      expect(item.metrics.llmNodeTtfs).toBeGreaterThan(item.metrics.ttsNodeTtfb!);
    } finally {
      await session.close();
    }
  });
});
