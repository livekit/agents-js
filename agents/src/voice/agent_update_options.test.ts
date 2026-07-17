// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import {
  BaseStreamingTurnDetector,
  type BaseStreamingTurnDetectorStream,
} from '../inference/eot/base.js';
import { ThresholdOptions, type TurnDetectorModel } from '../inference/eot/languages.js';
import { ChatContext } from '../llm/chat_context.js';
import { type RealtimeCapabilities, RealtimeModel, RealtimeSession } from '../llm/index.js';
import type { GenerationCreatedEvent } from '../llm/realtime.js';
import { ToolContext } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { type ChunkedStream, SynthesizeStream, TTS } from '../tts/index.js';
import type { APIConnectOptions } from '../types.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { VAD, VADStream } from '../vad.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import type { AudioRecognition } from './audio_recognition.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

class FakeVAD extends VAD {
  label = 'fake-vad';

  constructor() {
    super({ updateInterval: 100 });
  }

  stream(): VADStream {
    return new FakeVADStream(this);
  }
}

class FakeVADStream extends VADStream {}

class LowSilenceVAD extends FakeVAD {
  override get minSilenceDuration(): number {
    return 0;
  }
}

class FakeSynthesizeStream extends SynthesizeStream {
  label = 'fake-tts-stream';

  protected async run(): Promise<void> {}
}

class FakeTTS extends TTS {
  label = 'fake-tts';

  constructor() {
    super(24000, 1, { streaming: true });
  }

  synthesize(): ChunkedStream {
    throw new Error('not implemented');
  }

  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new FakeSynthesizeStream(this, options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS);
  }
}

class LabeledSTT extends FakeSTT {
  override get model(): string {
    return 'new-model';
  }

  override get provider(): string {
    return 'new-provider';
  }
}

class FakeRealtimeSession extends RealtimeSession {
  get chatCtx(): ChatContext {
    return ChatContext.empty();
  }

  get tools(): ToolContext {
    return ToolContext.empty();
  }

  async updateInstructions(): Promise<void> {}

  async updateChatCtx(): Promise<void> {}

  async updateTools(): Promise<void> {}

  updateOptions(): void {}

  pushAudio(_frame: AudioFrame): void {}

  async generateReply(): Promise<GenerationCreatedEvent> {
    throw new Error('not implemented');
  }

  async commitAudio(): Promise<void> {}

  async clearAudio(): Promise<void> {}

  async interrupt(): Promise<void> {}

  async truncate(): Promise<void> {}
}

class FakeRealtimeModel extends RealtimeModel {
  constructor() {
    const capabilities: RealtimeCapabilities = {
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: false,
      audioOutput: true,
      manualFunctionCalls: false,
    };
    super(capabilities);
  }

  get model(): string {
    return 'fake-realtime';
  }

  session(): RealtimeSession {
    return new FakeRealtimeSession(this);
  }

  async close(): Promise<void> {}
}

class FakeStreamingTurnDetector extends BaseStreamingTurnDetector {
  constructor() {
    super({
      sampleRate: 16000,
      thresholds: new ThresholdOptions('turn-detector-v1-mini'),
    });
  }

  get model(): TurnDetectorModel {
    return 'turn-detector-v1-mini';
  }

  stream(): BaseStreamingTurnDetectorStream {
    throw new Error('not implemented');
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('Agent.updateOptions', () => {
  it('replaces model fields when the agent is not running', async () => {
    const stt1 = new FakeSTT();
    const stt2 = new FakeSTT();
    const vad1 = new FakeVAD();
    const vad2 = new FakeVAD();
    const llm1 = new FakeLLM();
    const llm2 = new FakeLLM();
    const tts1 = new FakeTTS();
    const tts2 = new FakeTTS();

    const agent = new Agent({ instructions: 'test', stt: stt1, vad: vad1, llm: llm1, tts: tts1 });
    await agent.updateOptions({ stt: stt2, vad: vad2, llm: llm2, tts: tts2 });

    expect(agent.stt).toBe(stt2);
    expect(agent.vad).toBe(vad2);
    expect(agent.llm).toBe(llm2);
    expect(agent.tts).toBe(tts2);
  });

  it('only touches provided models when the agent is not running', async () => {
    const stt = new FakeSTT();
    const llm = new FakeLLM();
    const tts = new FakeTTS();
    const agent = new Agent({ instructions: 'test', stt, llm });

    await agent.updateOptions({ tts });

    expect(agent.stt).toBe(stt);
    expect(agent.llm).toBe(llm);
    expect(agent.tts).toBe(tts);
  });

  it('swaps TTS while running', async () => {
    const oldTts = new FakeTTS();
    const newTts = new FakeTTS();
    const agent = new Agent({ instructions: 'test', llm: new FakeLLM(), tts: oldTts });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const activity = session._activity!;

      await agent.updateOptions({ tts: newTts });

      expect(agent.tts).toBe(newTts);
      expect(activity.tts).toBe(newTts);
      expect(oldTts.listenerCount('metrics_collected')).toBe(0);
      expect(newTts.listenerCount('metrics_collected')).toBeGreaterThan(0);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('swaps LLM while running', async () => {
    const oldLlm = new FakeLLM();
    const newLlm = new FakeLLM();
    const agent = new Agent({ instructions: 'test', llm: oldLlm });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const activity = session._activity!;

      await agent.updateOptions({ llm: newLlm });

      expect(agent.llm).toBe(newLlm);
      expect(activity.llm).toBe(newLlm);
      expect(oldLlm.listenerCount('metrics_collected')).toBe(0);
      expect(newLlm.listenerCount('metrics_collected')).toBeGreaterThan(0);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('swaps STT and rewires the live pipeline while running', async () => {
    const oldStt = new FakeSTT();
    const newStt = new FakeSTT();
    const agent = new Agent({
      instructions: 'test',
      stt: oldStt,
      vad: new FakeVAD(),
      llm: new FakeLLM(),
      tts: new FakeTTS(),
    });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const activity = session._activity!;
      const recognition = (activity as unknown as { audioRecognition: unknown }).audioRecognition;
      const oldPipeline = (recognition as { sttPipeline: unknown }).sttPipeline;

      await agent.updateOptions({ stt: newStt });

      expect(agent.stt).toBe(newStt);
      expect(activity.stt).toBe(newStt);
      expect((recognition as { sttPipeline: unknown }).sttPipeline).not.toBe(oldPipeline);
      expect(oldStt.listenerCount('metrics_collected')).toBe(0);
      expect(newStt.listenerCount('metrics_collected')).toBeGreaterThan(0);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('serializes concurrent STT swaps so only the final model retains listeners', async () => {
    const oldStt = new FakeSTT();
    const firstStt = new FakeSTT();
    const finalStt = new FakeSTT();
    const agent = new Agent({
      instructions: 'test',
      stt: oldStt,
      vad: new FakeVAD(),
      llm: new FakeLLM(),
      tts: new FakeTTS(),
    });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const activity = session._activity!;
      const recognition = (activity as unknown as { audioRecognition: AudioRecognition })
        .audioRecognition;
      const originalUpdateStt = recognition.updateStt.bind(recognition);
      const firstSwapBlocked = deferred();
      const releaseFirstSwap = deferred();
      let updateCount = 0;

      vi.spyOn(recognition, 'updateStt').mockImplementation(async (...args) => {
        updateCount += 1;
        if (updateCount === 1) {
          firstSwapBlocked.resolve();
          await releaseFirstSwap.promise;
        }
        await originalUpdateStt(...args);
      });

      const firstSwap = agent.updateOptions({ stt: firstStt });
      await firstSwapBlocked.promise;
      const finalSwap = agent.updateOptions({ stt: finalStt });
      releaseFirstSwap.resolve();
      await Promise.all([firstSwap, finalSwap]);

      expect(agent.stt).toBe(finalStt);
      expect(oldStt.listenerCount('metrics_collected')).toBe(0);
      expect(firstStt.listenerCount('metrics_collected')).toBe(0);
      expect(finalStt.listenerCount('metrics_collected')).toBeGreaterThan(0);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('swaps VAD while running', async () => {
    const oldVad = new FakeVAD();
    const newVad = new FakeVAD();
    const agent = new Agent({
      instructions: 'test',
      stt: new FakeSTT(),
      vad: oldVad,
      llm: new FakeLLM(),
      tts: new FakeTTS(),
    });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const activity = session._activity!;

      await agent.updateOptions({ vad: newVad });

      expect(agent.vad).toBe(newVad);
      expect(activity.vad).toBe(newVad);
      expect(oldVad.listenerCount('metrics_collected')).toBe(0);
      expect(newVad.listenerCount('metrics_collected')).toBeGreaterThan(0);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('treats a runtime VAD replacement as user-provided after inheriting the session default', async () => {
    const replacementVad = new FakeVAD();
    const agent = new Agent({
      instructions: 'test',
      stt: new FakeSTT(),
      llm: new FakeLLM(),
      tts: new FakeTTS(),
    });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const activity = session._activity!;
      const recognition = (activity as unknown as { audioRecognition: unknown }).audioRecognition;

      expect(activity.usingDefaultVad).toBe(true);
      expect((recognition as { hasUserVad: boolean }).hasUserVad).toBe(false);

      await agent.updateOptions({ vad: replacementVad });

      expect(activity.usingDefaultVad).toBe(false);
      expect((recognition as { hasUserVad: boolean }).hasUserVad).toBe(true);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('disables STT while running', async () => {
    const agent = new Agent({
      instructions: 'test',
      stt: new FakeSTT(),
      vad: new FakeVAD(),
      llm: new FakeLLM(),
      tts: new FakeTTS(),
    });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const activity = session._activity!;

      await agent.updateOptions({ stt: null });

      expect(agent.stt).toBeNull();
      expect(activity.stt).toBeUndefined();
      const recognition = (activity as unknown as { audioRecognition: unknown }).audioRecognition;
      expect((recognition as { sttPipeline: unknown }).sttPipeline).toBeUndefined();
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('rejects swapping to a RealtimeModel while running', async () => {
    const agent = new Agent({ instructions: 'test', llm: new FakeLLM() });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      await expect(agent.updateOptions({ llm: new FakeRealtimeModel() })).rejects.toThrow(
        'RealtimeModel',
      );
      expect(agent.llm).toBeInstanceOf(FakeLLM);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('rejects swapping away from a RealtimeModel while running', async () => {
    const agent = new Agent({ instructions: 'test', llm: new FakeRealtimeModel() });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      await expect(agent.updateOptions({ llm: new FakeLLM() })).rejects.toThrow('RealtimeModel');
      expect(agent.llm).toBeInstanceOf(FakeRealtimeModel);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('refreshes STT model and provider on swap', async () => {
    const agent = new Agent({
      instructions: 'test',
      stt: new FakeSTT(),
      vad: new FakeVAD(),
      llm: new FakeLLM(),
      tts: new FakeTTS(),
    });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const recognition = (session._activity as unknown as { audioRecognition: unknown })
        .audioRecognition;

      await agent.updateOptions({ stt: new LabeledSTT() });

      expect((recognition as { sttModel: unknown }).sttModel).toBe('new-model');
      expect((recognition as { sttProvider: unknown }).sttProvider).toBe('new-provider');
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('checks VAD silence requirements atomically', async () => {
    const oldStt = new FakeSTT();
    const oldVad = new FakeVAD();
    const agent = new Agent({
      instructions: 'test',
      stt: oldStt,
      vad: oldVad,
      llm: new FakeLLM(),
      tts: new FakeTTS(),
    });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const recognition = (session._activity as unknown as { audioRecognition: unknown })
        .audioRecognition;
      (recognition as { turnDetector: unknown }).turnDetector = new FakeStreamingTurnDetector();

      await expect(
        agent.updateOptions({ stt: new FakeSTT(), vad: new LowSilenceVAD() }),
      ).rejects.toThrow('minSilenceDuration');

      expect(agent.stt).toBe(oldStt);
      expect(agent.vad).toBe(oldVad);
    } finally {
      await session.close().catch(() => {});
    }
  });
});
