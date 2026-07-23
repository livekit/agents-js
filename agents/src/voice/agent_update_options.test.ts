// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import type { voice } from '../index.js';
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
import { AgentSessionEventTypes } from './events.js';
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

class ThrowingPrewarmLLM extends FakeLLM {
  override prewarm(): void {
    throw new Error('injected LLM prewarm failure');
  }
}

class ThrowingPrewarmTTS extends FakeTTS {
  prewarm(): void {
    throw new Error('injected TTS prewarm failure');
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

class ContextSTT extends FakeSTT {
  keytermUpdates: string[][] = [];
  contextUpdates: Array<Parameters<FakeSTT['_pushConversationItem']>[0]> = [];

  constructor(label: string) {
    super({ label });
    this.updateCapabilities({ chatContext: true, keyterms: true });
  }

  override _updateSessionKeyterms(keyterms: string[]): void {
    this.keytermUpdates.push([...keyterms]);
  }

  override _pushConversationItem(ev: Parameters<FakeSTT['_pushConversationItem']>[0]): void {
    this.contextUpdates.push(ev);
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
  it('exports AgentUpdateOptions from the public voice namespace', () => {
    const options: voice.AgentUpdateOptions = { stt: null, vad: null, llm: null, tts: null };
    expect(options).toEqual({ stt: null, vad: null, llm: null, tts: null });
  });

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

  it('serializes an STT swap with activity close and leaves no listeners attached', async () => {
    const oldStt = new FakeSTT();
    const replacementStt = new FakeSTT();
    const agent = new Agent({
      instructions: 'test',
      stt: oldStt,
      vad: new FakeVAD(),
      llm: new FakeLLM(),
      tts: new FakeTTS(),
    });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    const activity = session._activity!;
    const recognition = (activity as unknown as { audioRecognition: AudioRecognition })
      .audioRecognition;
    const originalUpdateStt = recognition.updateStt.bind(recognition);
    const swapBlocked = deferred();
    const releaseSwap = deferred();
    vi.spyOn(recognition, 'updateStt').mockImplementation(async (...args) => {
      swapBlocked.resolve();
      await releaseSwap.promise;
      await originalUpdateStt(...args);
    });

    const swap = agent.updateOptions({ stt: replacementStt });
    await swapBlocked.promise;
    const close = activity.close();
    expect(agent._agentActivity).toBe(activity);

    releaseSwap.resolve();
    await Promise.all([swap, close]);

    expect(agent._agentActivity).toBeUndefined();
    expect(oldStt.listenerCount('metrics_collected')).toBe(0);
    expect(oldStt.listenerCount('error')).toBe(0);
    expect(replacementStt.listenerCount('metrics_collected')).toBe(0);
    expect(replacementStt.listenerCount('error')).toBe(0);
    await session.close().catch(() => {});
  });

  it('keeps a queued update state-only when handoff pauses the old activity', async () => {
    const oldStt = new ContextSTT('old-stt');
    const oldLlm = new FakeLLM();
    const oldTts = new FakeTTS();
    const oldAgent = new Agent({
      instructions: 'old',
      stt: oldStt,
      llm: oldLlm,
      tts: oldTts,
    });
    const newStt = new ContextSTT('new-stt');
    const newAgent = new Agent({
      instructions: 'new',
      stt: newStt,
      llm: new FakeLLM(),
      tts: new FakeTTS(),
    });
    const replacementStt = new ContextSTT('replacement-stt');
    const replacementLlm = new FakeLLM();
    const replacementTts = new FakeTTS();
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent: oldAgent });

    try {
      const oldActivity = session._activity!;
      const pauseResourcesClosed = deferred();
      const releasePause = deferred();
      const internals = oldActivity as unknown as {
        _closeSessionResources: () => Promise<void>;
      };
      const originalCloseResources = internals._closeSessionResources.bind(internals);
      vi.spyOn(internals, '_closeSessionResources').mockImplementation(async () => {
        await originalCloseResources();
        pauseResourcesClosed.resolve();
        await releasePause.promise;
      });

      const handoff = session._updateActivity(newAgent, { previousActivity: 'pause' });
      await pauseResourcesClosed.promise;
      const queuedUpdate = oldAgent.updateOptions({
        stt: replacementStt,
        llm: replacementLlm,
        tts: replacementTts,
      });
      releasePause.resolve();
      await Promise.all([queuedUpdate, handoff]);

      expect(oldAgent.stt).toBe(replacementStt);
      expect(oldAgent.llm).toBe(replacementLlm);
      expect(oldAgent.tts).toBe(replacementTts);
      for (const model of [
        oldStt,
        oldLlm,
        oldTts,
        replacementStt,
        replacementLlm,
        replacementTts,
      ]) {
        expect(model.listenerCount('metrics_collected')).toBe(0);
        expect(model.listenerCount('error')).toBe(0);
      }

      const handoffCtx = ChatContext.empty();
      handoffCtx.addMessage({ role: 'user', content: 'after handoff' });
      const handoffEvent = { item: handoffCtx.items[0]! };
      session.emit(AgentSessionEventTypes.ConversationItemAdded, handoffEvent);
      expect(replacementStt.contextUpdates).toHaveLength(0);
      expect(newStt.contextUpdates).toEqual([handoffEvent]);

      await session._updateActivity(oldAgent, {
        previousActivity: 'pause',
        newActivity: 'resume',
      });
      expect(session._activity).toBe(oldActivity);
      expect(replacementStt.listenerCount('metrics_collected')).toBeGreaterThan(0);
      expect(replacementLlm.listenerCount('metrics_collected')).toBeGreaterThan(0);
      expect(replacementTts.listenerCount('metrics_collected')).toBeGreaterThan(0);

      const resumedCtx = ChatContext.empty();
      resumedCtx.addMessage({ role: 'user', content: 'after resume' });
      const resumedEvent = { item: resumedCtx.items[0]! };
      session.emit(AgentSessionEventTypes.ConversationItemAdded, resumedEvent);
      expect(replacementStt.contextUpdates).toEqual([resumedEvent]);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('moves STT context, keyterms, and error listeners to the replacement', async () => {
    const oldStt = new ContextSTT('old-context-stt');
    const replacementStt = new ContextSTT('replacement-context-stt');
    const agent = new Agent({ instructions: 'test', stt: oldStt });
    const session = new AgentSession({
      turnDetection: 'manual',
      keytermsOptions: { keyterms: ['LiveKit'] },
    });
    await session.start({ agent });
    try {
      await agent.updateOptions({ stt: replacementStt });
      const itemCtx = ChatContext.empty();
      itemCtx.addMessage({ role: 'user', content: 'hello' });
      const event = { item: itemCtx.items[0]! };
      session.emit(AgentSessionEventTypes.ConversationItemAdded, event);

      expect(oldStt.contextUpdates).toHaveLength(0);
      expect(replacementStt.contextUpdates).toEqual([event]);
      expect(replacementStt.keytermUpdates).toContainEqual(['LiveKit']);
      expect(oldStt.listenerCount('error')).toBe(0);
      expect(replacementStt.listenerCount('error')).toBeGreaterThan(0);
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

      expect(agent._stt).toBeNull();
      expect(agent.stt).toBeUndefined();
      expect(activity.stt).toBeUndefined();
      const recognition = (activity as unknown as { audioRecognition: unknown }).audioRecognition;
      expect((recognition as { sttPipeline: unknown }).sttPipeline).toBeUndefined();
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('uses session fallbacks when omitted and suppresses all four with null', async () => {
    const sessionStt = new FakeSTT();
    const sessionVad = new FakeVAD();
    const sessionLlm = new FakeLLM();
    const sessionTts = new FakeTTS();
    const agent = new Agent({ instructions: 'test' });
    const session = new AgentSession({
      turnDetection: 'manual',
      stt: sessionStt,
      vad: sessionVad,
      llm: sessionLlm,
      tts: sessionTts,
    });
    await session.start({ agent });
    try {
      const activity = session._activity!;
      expect(activity.stt).toBe(sessionStt);
      expect(activity.vad).toBe(sessionVad);
      expect(activity.llm).toBe(sessionLlm);
      expect(activity.tts).toBe(sessionTts);

      await agent.updateOptions({ stt: null, vad: null, llm: null, tts: null });

      expect(agent._stt).toBeNull();
      expect(agent._vad).toBeNull();
      expect(agent._llm).toBeNull();
      expect(agent._tts).toBeNull();
      expect(agent.stt).toBeUndefined();
      expect(agent.vad).toBeUndefined();
      expect(agent.llm).toBeUndefined();
      expect(agent.tts).toBeUndefined();
      expect(activity.stt).toBeUndefined();
      expect(activity.vad).toBeUndefined();
      expect(activity.llm).toBeUndefined();
      expect(activity.tts).toBeUndefined();
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('removes listeners from every model after sequential swaps and close', async () => {
    const stts = [new FakeSTT(), new FakeSTT(), new FakeSTT()];
    const llms = [new FakeLLM(), new FakeLLM(), new FakeLLM()];
    const ttss = [new FakeTTS(), new FakeTTS(), new FakeTTS()];
    const agent = new Agent({
      instructions: 'test',
      stt: stts[0],
      llm: llms[0],
      tts: ttss[0],
    });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });

    await agent.updateOptions({ stt: stts[1], llm: llms[1], tts: ttss[1] });
    await agent.updateOptions({ stt: stts[2], llm: llms[2], tts: ttss[2] });
    await session.close();

    for (const model of [...stts, ...llms, ...ttss]) {
      expect(model.listenerCount('metrics_collected')).toBe(0);
      expect(model.listenerCount('error')).toBe(0);
    }
  });

  it('rolls back a multi-model update when LLM prewarm throws', async () => {
    const oldStt = new ContextSTT('old-stt');
    const oldVad = new FakeVAD();
    const oldLlm = new FakeLLM();
    const replacementStt = new ContextSTT('replacement-stt');
    const replacementVad = new FakeVAD();
    const replacementLlm = new ThrowingPrewarmLLM();
    const agent = new Agent({
      instructions: 'test',
      stt: oldStt,
      vad: oldVad,
      llm: oldLlm,
      tts: new FakeTTS(),
    });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const activity = session._activity!;
      const recognition = (activity as unknown as { audioRecognition: AudioRecognition })
        .audioRecognition;
      const internals = recognition as unknown as {
        sttPipeline: unknown;
        vadTask: unknown;
        transcriptBuffer: string[];
        sttRequestIds: string[];
        lastLanguage: string | undefined;
      };
      internals.transcriptBuffer = ['partial transcript'];
      internals.sttRequestIds = ['request-before-prewarm'];
      internals.lastLanguage = 'en';
      const previousSttPipeline = internals.sttPipeline;
      const previousVadTask = internals.vadTask;
      const previousTranscriptBuffer = internals.transcriptBuffer;
      const previousSttRequestIds = internals.sttRequestIds;

      await expect(
        agent.updateOptions({
          stt: replacementStt,
          vad: replacementVad,
          llm: replacementLlm,
        }),
      ).rejects.toThrow('injected LLM prewarm failure');
      expect(agent.stt).toBe(oldStt);
      expect(agent.vad).toBe(oldVad);
      expect(agent.llm).toBe(oldLlm);
      expect(internals.sttPipeline).toBe(previousSttPipeline);
      expect(internals.vadTask).toBe(previousVadTask);
      expect(internals.transcriptBuffer).toBe(previousTranscriptBuffer);
      expect(internals.transcriptBuffer).toEqual(['partial transcript']);
      expect(internals.sttRequestIds).toBe(previousSttRequestIds);
      expect(internals.sttRequestIds).toEqual(['request-before-prewarm']);
      expect(internals.lastLanguage).toBe('en');
      expect(oldStt.listenerCount('metrics_collected')).toBe(1);
      expect(oldStt.listenerCount('error')).toBe(1);
      expect(oldVad.listenerCount('metrics_collected')).toBe(1);
      expect(oldLlm.listenerCount('metrics_collected')).toBe(1);
      expect(oldLlm.listenerCount('error')).toBe(1);
      expect(replacementStt.listenerCount('metrics_collected')).toBe(0);
      expect(replacementStt.listenerCount('error')).toBe(0);
      expect(replacementVad.listenerCount('metrics_collected')).toBe(0);
      expect(replacementLlm.listenerCount('metrics_collected')).toBe(0);
      expect(replacementLlm.listenerCount('error')).toBe(0);
      expect(session.listenerCount(AgentSessionEventTypes.ConversationItemAdded)).toBe(1);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('rolls back STT recognition and keyterm ownership when keyterm swap throws', async () => {
    const oldStt = new ContextSTT('old-stt');
    const replacementStt = new ContextSTT('replacement-stt');
    const agent = new Agent({ instructions: 'test', stt: oldStt });
    const session = new AgentSession({
      turnDetection: 'manual',
      keytermsOptions: { keyterms: ['LiveKit'] },
    });
    await session.start({ agent });
    try {
      const detector = session._keytermDetector;
      const originalSwap = detector.swapStt.bind(detector);
      vi.spyOn(detector, 'swapStt').mockImplementation((stt) => {
        originalSwap(stt);
        throw new Error('injected keyterm swap failure');
      });
      await expect(agent.updateOptions({ stt: replacementStt })).rejects.toThrow(
        'injected keyterm swap failure',
      );
      expect(agent.stt).toBe(oldStt);
      expect(oldStt.listenerCount('metrics_collected')).toBe(1);
      expect(oldStt.listenerCount('error')).toBe(1);
      expect(replacementStt.listenerCount('metrics_collected')).toBe(0);
      expect(replacementStt.listenerCount('error')).toBe(0);
      expect(session.listenerCount(AgentSessionEventTypes.ConversationItemAdded)).toBe(1);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('preflights TTS prewarm before mutating another model', async () => {
    const oldStt = new ContextSTT('old-stt');
    const oldVad = new FakeVAD();
    const oldTts = new FakeTTS();
    const replacementStt = new ContextSTT('replacement-stt');
    const replacementVad = new FakeVAD();
    const agent = new Agent({
      instructions: 'test',
      stt: oldStt,
      vad: oldVad,
      tts: oldTts,
    });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const activity = session._activity!;
      const recognition = (activity as unknown as { audioRecognition: AudioRecognition })
        .audioRecognition;
      const internals = recognition as unknown as { vadTask: unknown };
      const previousVadTask = internals.vadTask;

      await expect(
        agent.updateOptions({
          stt: replacementStt,
          vad: replacementVad,
          tts: new ThrowingPrewarmTTS(),
        }),
      ).rejects.toThrow('injected TTS prewarm failure');
      expect(agent.stt).toBe(oldStt);
      expect(agent.vad).toBe(oldVad);
      expect(agent.tts).toBe(oldTts);
      expect(internals.vadTask).toBe(previousVadTask);
      expect(oldStt.listenerCount('metrics_collected')).toBe(1);
      expect(oldStt.listenerCount('error')).toBe(1);
      expect(oldVad.listenerCount('metrics_collected')).toBe(1);
      expect(oldTts.listenerCount('metrics_collected')).toBe(1);
      expect(oldTts.listenerCount('error')).toBe(1);
      expect(replacementStt.listenerCount('metrics_collected')).toBe(0);
      expect(replacementStt.listenerCount('error')).toBe(0);
      expect(replacementVad.listenerCount('metrics_collected')).toBe(0);
      expect(session.listenerCount(AgentSessionEventTypes.ConversationItemAdded)).toBe(1);
      await agent.updateOptions({
        stt: replacementStt,
        vad: replacementVad,
        tts: new FakeTTS(),
      });
      expect(agent.stt).toBe(replacementStt);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('rolls back after recognition STT replacement fails operationally', async () => {
    const oldStt = new ContextSTT('old-stt');
    const replacementStt = new ContextSTT('replacement-stt');
    const agent = new Agent({ instructions: 'test', stt: oldStt });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const activity = session._activity!;
      const recognition = (activity as unknown as { audioRecognition: AudioRecognition })
        .audioRecognition;
      const originalUpdateStt = recognition.updateStt.bind(recognition);
      let fail = true;
      const spy = vi.spyOn(recognition, 'updateStt').mockImplementation(async (...args) => {
        await originalUpdateStt(...args);
        if (fail) {
          fail = false;
          throw new Error('injected recognition STT failure');
        }
      });
      await expect(agent.updateOptions({ stt: replacementStt })).rejects.toThrow(
        'injected recognition STT failure',
      );
      expect(agent.stt).toBe(oldStt);
      expect(oldStt.listenerCount('metrics_collected')).toBe(1);
      expect(oldStt.listenerCount('error')).toBe(1);
      expect(replacementStt.listenerCount('metrics_collected')).toBe(0);
      expect(replacementStt.listenerCount('error')).toBe(0);
      expect(session.listenerCount(AgentSessionEventTypes.ConversationItemAdded)).toBe(1);
      spy.mockRestore();
      await agent.updateOptions({ stt: replacementStt });
      expect(agent.stt).toBe(replacementStt);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('rolls back VAD reference and task ownership after an operational failure', async () => {
    const oldVad = new FakeVAD();
    const replacementVad = new FakeVAD();
    replacementVad.label = 'replacement-vad';
    const agent = new Agent({ instructions: 'test', vad: oldVad });
    const session = new AgentSession({ turnDetection: 'manual' });
    await session.start({ agent });
    try {
      const activity = session._activity!;
      const recognition = (activity as unknown as { audioRecognition: AudioRecognition })
        .audioRecognition;
      const originalUpdateVad = recognition.updateVad.bind(recognition);
      let fail = true;
      const spy = vi.spyOn(recognition, 'updateVad').mockImplementation(async (...args) => {
        await originalUpdateVad(...args);
        if (fail) {
          fail = false;
          throw new Error('injected recognition VAD failure');
        }
      });
      await expect(agent.updateOptions({ vad: replacementVad })).rejects.toThrow(
        'injected recognition VAD failure',
      );
      expect(agent.vad).toBe(oldVad);
      expect(oldVad.listenerCount('metrics_collected')).toBe(1);
      expect(replacementVad.listenerCount('metrics_collected')).toBe(0);
      expect((recognition as unknown as { vad: VAD }).vad).toBe(oldVad);
      spy.mockRestore();
      await agent.updateOptions({ vad: replacementVad });
      expect(agent.vad).toBe(replacementVad);
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
