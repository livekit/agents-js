// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
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
import { Agent, type AgentUpdateOptions } from './agent.js';
import { AgentSession } from './agent_session.js';
import type { AudioRecognition } from './audio_recognition.js';
import { AgentSessionEventTypes } from './events.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

class FakeVADStream extends VADStream {}

class FakeVAD extends VAD {
  label = 'fake-vad';
  constructor() {
    super({ updateInterval: 100 });
  }
  stream(): VADStream {
    return new FakeVADStream(this);
  }
}

/** Below the turn detector's silence floor, so binding one must be rejected. */
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

/** Records the chat-context and keyterm pushes the pipeline routes to its bound STT. */
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
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: false,
      autoToolReplyGeneration: false,
      audioOutput: true,
      manualFunctionCalls: false,
    } satisfies RealtimeCapabilities);
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
    super({ sampleRate: 16000, thresholds: new ThresholdOptions('turn-detector-v1-mini') });
  }
  get model(): TurnDetectorModel {
    return 'turn-detector-v1-mini';
  }
  stream(): BaseStreamingTurnDetectorStream {
    throw new Error('not implemented');
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const SLOTS = ['stt', 'vad', 'llm', 'tts'] as const;
type Slot = (typeof SLOTS)[number];

/** The four resolved model slots of an `Agent` or `AgentActivity`, for whole-object compares. */
const slotsOf = (target: Record<Slot, unknown>) => ({
  stt: target.stt,
  vad: target.vad,
  llm: target.llm,
  tts: target.tts,
});

/** A fresh fake in every slot, spreadable into both `Agent` and `AgentSession` options. */
const allModels = () => ({
  stt: new FakeSTT(),
  vad: new FakeVAD(),
  llm: new FakeLLM(),
  tts: new FakeTTS(),
});

/** The `AudioRecognition` internals these tests reach into to prove the pipeline moved. */
type RecognitionInternals = AudioRecognition & {
  sttPipeline: unknown;
  vadTask: unknown;
  vad: VAD | undefined;
  turnDetector: unknown;
  sttModel: string | undefined;
  sttProvider: string | undefined;
  hasUserVad: boolean;
  transcriptBuffer: string[];
  sttRequestIds: string[];
  lastLanguage: string | undefined;
};

type Emitter = { listenerCount(event: string): number };

/** The live recognition state a rolled-back update must leave exactly as it found it. */
const recognitionState = (rec: RecognitionInternals) => ({
  sttPipeline: rec.sttPipeline,
  vadTask: rec.vadTask,
  transcriptBuffer: rec.transcriptBuffer,
  sttRequestIds: rec.sttRequestIds,
  lastLanguage: rec.lastLanguage,
});

/**
 * Start a manual-turn session and close it when the test finishes, so the tests below
 * read as scenario + assertions with no lifecycle boilerplate.
 */
async function start(
  agentOptions: Record<string, unknown> = {},
  sessionOptions: Record<string, unknown> = {},
) {
  const agent = new Agent({ instructions: 'test', ...agentOptions });
  const session = new AgentSession({ turnDetection: 'manual', ...sessionOptions });
  await session.start({ agent });
  onTestFinished(() => session.close().catch(() => {}));
  const activity = session._activity!;
  return {
    agent,
    session,
    activity,
    rec: (activity as unknown as { audioRecognition: RecognitionInternals }).audioRecognition,
  };
}

/** No wiring left: the model was fully unbound from the activity. */
function expectDetached(...models: Emitter[]): void {
  for (const model of models) {
    expect(model.listenerCount('metrics_collected')).toBe(0);
    expect(model.listenerCount('error')).toBe(0);
  }
}

/**
 * Wired exactly once. Rollback has to *restore* the original wiring, so a duplicate
 * listener is as much a bug as a missing one. VAD gets no `error` listener.
 */
function expectWiredOnce(model: Emitter, { error = true } = {}): void {
  expect(model.listenerCount('metrics_collected')).toBe(1);
  if (error) expect(model.listenerCount('error')).toBe(1);
}

/** Emit a conversation item and return it, to see which STT the pipeline routes to. */
function emitConversationItem(session: AgentSession, content: string) {
  const ctx = ChatContext.empty();
  ctx.addMessage({ role: 'user', content });
  const event = { item: ctx.items[0]! };
  session.emit(AgentSessionEventTypes.ConversationItemAdded, event);
  return event;
}

describe('Agent.updateOptions', () => {
  it('exports AgentUpdateOptions from the public voice namespace', () => {
    const options: voice.AgentUpdateOptions = { stt: null, vad: null, llm: null, tts: null };
    expect(options).toEqual({ stt: null, vad: null, llm: null, tts: null });
  });

  // Mirrors Python's `is_given()`: only fields with a defined value are applied, so an
  // omitted key and an explicit `undefined` behave identically. There is deliberately no
  // way to drop an override and go back to inheriting the session.
  describe('undefined is the same as omitted', () => {
    it('leaves every field alone', async () => {
      const models = allModels();
      const agent = new Agent({ instructions: 'test', ...models, expressive: true });

      await agent.updateOptions({});
      await agent.updateOptions({
        stt: undefined,
        vad: undefined,
        llm: undefined,
        tts: undefined,
        expressive: undefined,
      });

      expect(slotsOf(agent)).toEqual(models);
      expect(agent._expressive).toBe(true);
    });

    it('still disables with null and false, overriding the session', async () => {
      const agent = new Agent({ instructions: 'test', ...allModels(), expressive: true });

      await agent.updateOptions({ stt: null, vad: null, llm: null, tts: null, expressive: false });

      for (const slot of SLOTS) expect(agent[`_${slot}`]).toBeNull();
      expect(agent._expressive).toBe(false);
    });

    it('leaves a running agent alone when every field is undefined', async () => {
      const models = allModels();
      const { agent, activity } = await start(models);

      await agent.updateOptions({ stt: undefined, vad: undefined, tts: undefined });

      expect(slotsOf(agent)).toEqual(models);
      expect(slotsOf(activity)).toEqual(models);
      for (const model of Object.values(models)) {
        expect(model.listenerCount('metrics_collected')).toBeGreaterThan(0);
      }
    });
  });

  describe('when the agent is not running', () => {
    it('replaces every provided model field', async () => {
      const agent = new Agent({ instructions: 'test', ...allModels() });
      const next = allModels();

      await agent.updateOptions(next);

      expect(slotsOf(agent)).toEqual(next);
    });

    it('leaves omitted models untouched', async () => {
      const stt = new FakeSTT();
      const llm = new FakeLLM();
      const tts = new FakeTTS();
      const agent = new Agent({ instructions: 'test', stt, llm });

      await agent.updateOptions({ tts });

      expect({ stt: agent.stt, llm: agent.llm, tts: agent.tts }).toEqual({ stt, llm, tts });
    });
  });

  describe('while running', () => {
    it.each([
      ['stt', () => new FakeSTT()],
      ['vad', () => new FakeVAD()],
      ['llm', () => new FakeLLM()],
      ['tts', () => new FakeTTS()],
    ] as Array<[Slot, () => Emitter]>)(
      'swaps %s and moves the listeners to it',
      async (slot, makeReplacement) => {
        const models = allModels();
        const { agent, activity } = await start(models);
        const replacement = makeReplacement();

        await agent.updateOptions({ [slot]: replacement } as AgentUpdateOptions);

        expect(agent[slot]).toBe(replacement);
        expect(activity[slot]).toBe(replacement);
        expectDetached(models[slot]);
        expect(replacement.listenerCount('metrics_collected')).toBeGreaterThan(0);
      },
    );

    it('rebuilds the STT pipeline on swap and refreshes its model/provider', async () => {
      const { agent, rec } = await start(allModels());
      const previousPipeline = rec.sttPipeline;

      await agent.updateOptions({ stt: new LabeledSTT() });

      expect(rec.sttPipeline).not.toBe(previousPipeline);
      expect(rec.sttModel).toBe('new-model');
      expect(rec.sttProvider).toBe('new-provider');
    });

    it('moves STT context, keyterms, and error listeners to the replacement', async () => {
      const oldStt = new ContextSTT('old-stt');
      const replacementStt = new ContextSTT('replacement-stt');
      const { agent, session } = await start(
        { stt: oldStt },
        { keytermsOptions: { keyterms: ['LiveKit'] } },
      );

      await agent.updateOptions({ stt: replacementStt });
      const event = emitConversationItem(session, 'hello');

      expect(oldStt.contextUpdates).toHaveLength(0);
      expect(replacementStt.contextUpdates).toEqual([event]);
      expect(replacementStt.keytermUpdates).toContainEqual(['LiveKit']);
      expect(oldStt.listenerCount('error')).toBe(0);
      expect(replacementStt.listenerCount('error')).toBeGreaterThan(0);
    });

    it('treats a VAD replacement as user-provided after inheriting the session default', async () => {
      const { agent, activity, rec } = await start({
        stt: new FakeSTT(),
        llm: new FakeLLM(),
        tts: new FakeTTS(),
      });
      expect(activity.usingDefaultVad).toBe(true);
      expect(rec.hasUserVad).toBe(false);

      await agent.updateOptions({ vad: new FakeVAD() });

      expect(activity.usingDefaultVad).toBe(false);
      expect(rec.hasUserVad).toBe(true);
    });

    it('uses session fallbacks when omitted and suppresses all four with null', async () => {
      const sessionModels = allModels();
      const { agent, activity, rec } = await start({}, sessionModels);
      expect(slotsOf(activity)).toEqual(sessionModels);

      await agent.updateOptions({ stt: null, vad: null, llm: null, tts: null });

      for (const slot of SLOTS) {
        expect(agent[`_${slot}`]).toBeNull();
        expect(agent[slot]).toBeUndefined();
        expect(activity[slot]).toBeUndefined();
      }
      expect(rec.sttPipeline).toBeUndefined();
    });

    it('rejects swapping to or from a RealtimeModel', async () => {
      const { agent: plain } = await start({ llm: new FakeLLM() });
      await expect(plain.updateOptions({ llm: new FakeRealtimeModel() })).rejects.toThrow(
        'RealtimeModel',
      );
      expect(plain.llm).toBeInstanceOf(FakeLLM);

      const { agent: realtime } = await start({ llm: new FakeRealtimeModel() });
      await expect(realtime.updateOptions({ llm: new FakeLLM() })).rejects.toThrow('RealtimeModel');
      expect(realtime.llm).toBeInstanceOf(FakeRealtimeModel);
    });
  });

  describe('concurrency', () => {
    /** Block the recognition STT swap so a second call can be issued mid-flight. */
    function blockSttSwap(rec: AudioRecognition, { onlyFirst = false } = {}) {
      const original = rec.updateStt.bind(rec);
      const blocked = deferred();
      const release = deferred();
      let calls = 0;
      vi.spyOn(rec, 'updateStt').mockImplementation(async (...args) => {
        calls += 1;
        if (!onlyFirst || calls === 1) {
          blocked.resolve();
          await release.promise;
        }
        await original(...args);
      });
      return { blocked: blocked.promise, release: release.resolve };
    }

    it('serializes concurrent swaps so only the final model retains listeners', async () => {
      const models = allModels();
      const { agent, rec } = await start(models);
      const firstStt = new FakeSTT();
      const finalStt = new FakeSTT();
      const swap = blockSttSwap(rec, { onlyFirst: true });

      const first = agent.updateOptions({ stt: firstStt });
      await swap.blocked;
      const final = agent.updateOptions({ stt: finalStt });
      swap.release();
      await Promise.all([first, final]);

      expect(agent.stt).toBe(finalStt);
      expectDetached(models.stt, firstStt);
      expect(finalStt.listenerCount('metrics_collected')).toBeGreaterThan(0);
    });

    it('serializes a swap with activity close and leaves no listeners attached', async () => {
      const models = allModels();
      const { agent, activity, rec } = await start(models);
      const replacementStt = new FakeSTT();
      const swap = blockSttSwap(rec);

      const update = agent.updateOptions({ stt: replacementStt });
      await swap.blocked;
      const close = activity.close();
      expect(agent._agentActivity).toBe(activity);

      swap.release();
      await Promise.all([update, close]);

      expect(agent._agentActivity).toBeUndefined();
      expectDetached(models.stt, replacementStt);
    });

    it('keeps a queued update state-only while a handoff has the activity paused', async () => {
      const old = { stt: new ContextSTT('old-stt'), llm: new FakeLLM(), tts: new FakeTTS() };
      const oldAgent = new Agent({ instructions: 'old', ...old });
      const newStt = new ContextSTT('new-stt');
      const newAgent = new Agent({
        instructions: 'new',
        stt: newStt,
        llm: new FakeLLM(),
        tts: new FakeTTS(),
      });
      const replacement = {
        stt: new ContextSTT('replacement-stt'),
        llm: new FakeLLM(),
        tts: new FakeTTS(),
      };
      const session = new AgentSession({ turnDetection: 'manual' });
      await session.start({ agent: oldAgent });
      onTestFinished(() => session.close().catch(() => {}));
      const oldActivity = session._activity!;

      // Wedge the pause halfway through so the update lands while the old activity is
      // no longer the session's, and must therefore only touch state.
      const paused = deferred();
      const releasePause = deferred();
      const internals = oldActivity as unknown as { _closeSessionResources: () => Promise<void> };
      const originalClose = internals._closeSessionResources.bind(internals);
      vi.spyOn(internals, '_closeSessionResources').mockImplementation(async () => {
        await originalClose();
        paused.resolve();
        await releasePause.promise;
      });

      const handoff = session._updateActivity(newAgent, { previousActivity: 'pause' });
      await paused.promise;
      const queued = oldAgent.updateOptions(replacement);
      releasePause.resolve();
      await Promise.all([queued, handoff]);

      expect({ stt: oldAgent.stt, llm: oldAgent.llm, tts: oldAgent.tts }).toEqual(replacement);
      expectDetached(...Object.values(old), ...Object.values(replacement));
      // The live agent still owns the pipeline while the paused one is swapped out.
      const duringHandoff = emitConversationItem(session, 'after handoff');
      expect(replacement.stt.contextUpdates).toHaveLength(0);
      expect(newStt.contextUpdates).toEqual([duringHandoff]);

      await session._updateActivity(oldAgent, {
        previousActivity: 'pause',
        newActivity: 'resume',
      });

      expect(session._activity).toBe(oldActivity);
      for (const model of Object.values(replacement)) {
        expect(model.listenerCount('metrics_collected')).toBeGreaterThan(0);
      }
      const afterResume = emitConversationItem(session, 'after resume');
      expect(replacement.stt.contextUpdates).toEqual([afterResume]);
    });
  });

  describe('rollback', () => {
    /**
     * A prewarm failure is raised before any model is mutated, so the whole update must
     * be a no-op: same models, same live recognition state, no duplicated wiring.
     */
    it.each([
      ['LLM', 'injected LLM prewarm failure', () => ({ llm: new ThrowingPrewarmLLM() })],
      ['TTS', 'injected TTS prewarm failure', () => ({ tts: new ThrowingPrewarmTTS() })],
    ] as Array<[string, string, () => Partial<Record<Slot, Emitter>>]>)(
      'rolls the whole update back when %s prewarm throws',
      async (_label, message, makeThrower) => {
        const old = {
          stt: new ContextSTT('old-stt'),
          vad: new FakeVAD(),
          llm: new FakeLLM(),
          tts: new FakeTTS(),
        };
        const { agent, session, rec } = await start(old);
        const replacement = { stt: new ContextSTT('replacement-stt'), vad: new FakeVAD() };

        // In-flight recognition state must survive untouched, not be reset by the
        // partial swap that got rolled back.
        rec.transcriptBuffer = ['partial transcript'];
        rec.sttRequestIds = ['request-before-prewarm'];
        rec.lastLanguage = 'en';
        const before = recognitionState(rec);

        await expect(agent.updateOptions({ ...replacement, ...makeThrower() })).rejects.toThrow(
          message,
        );

        expect(slotsOf(agent)).toEqual(old);
        expect(recognitionState(rec)).toEqual(before);
        expectWiredOnce(old.stt);
        expectWiredOnce(old.llm);
        expectWiredOnce(old.tts);
        expectWiredOnce(old.vad, { error: false });
        expectDetached(...Object.values(replacement));
        expect(session.listenerCount(AgentSessionEventTypes.ConversationItemAdded)).toBe(1);

        // Recoverable: the same update applies once the failure is removed.
        await agent.updateOptions(replacement);
        expect(agent.stt).toBe(replacement.stt);
      },
    );

    it('restores STT recognition and keyterm ownership when the keyterm swap throws', async () => {
      const oldStt = new ContextSTT('old-stt');
      const replacementStt = new ContextSTT('replacement-stt');
      const { agent, session } = await start(
        { stt: oldStt },
        { keytermsOptions: { keyterms: ['LiveKit'] } },
      );
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
      expectWiredOnce(oldStt);
      expectDetached(replacementStt);
      expect(session.listenerCount(AgentSessionEventTypes.ConversationItemAdded)).toBe(1);
    });

    it.each([
      ['stt', 'updateStt', () => new ContextSTT('replacement-stt')],
      ['vad', 'updateVad', () => new FakeVAD()],
    ] as Array<[Slot, 'updateStt' | 'updateVad', () => Emitter]>)(
      'restores %s and its task ownership after the recognition update fails',
      async (slot, method, makeReplacement) => {
        const models = { stt: new ContextSTT('old-stt'), vad: new FakeVAD() };
        const { agent, rec } = await start(models);
        const replacement = makeReplacement();

        // Fail once, after the real work has run, so rollback has something to undo.
        let fail = true;
        const original = rec[method].bind(rec) as (...args: never[]) => Promise<void>;
        const spy = vi.spyOn(rec, method).mockImplementation(async (...args) => {
          await original(...(args as never[]));
          if (fail) {
            fail = false;
            throw new Error('injected recognition failure');
          }
        });

        await expect(
          agent.updateOptions({ [slot]: replacement } as AgentUpdateOptions),
        ).rejects.toThrow('injected recognition failure');

        expect(agent[slot]).toBe(models[slot]);
        expectWiredOnce(models[slot], { error: slot === 'stt' });
        expectDetached(replacement);
        if (slot === 'vad') expect(rec.vad).toBe(models.vad);

        // Recoverable: the same update succeeds once the injected failure is gone.
        spy.mockRestore();
        await agent.updateOptions({ [slot]: replacement } as AgentUpdateOptions);
        expect(agent[slot]).toBe(replacement);
      },
    );

    it('checks VAD silence requirements before mutating anything', async () => {
      const models = allModels();
      const { agent, rec } = await start(models);
      rec.turnDetector = new FakeStreamingTurnDetector();

      await expect(
        agent.updateOptions({ stt: new FakeSTT(), vad: new LowSilenceVAD() }),
      ).rejects.toThrow('minSilenceDuration');

      expect(agent.stt).toBe(models.stt);
      expect(agent.vad).toBe(models.vad);
    });
  });

  it('leaves no listeners on any model after sequential swaps and close', async () => {
    const generations = [allModels(), allModels(), allModels()];
    const { agent, session } = await start(generations[0]!);

    await agent.updateOptions(generations[1]!);
    await agent.updateOptions(generations[2]!);
    await session.close();

    expectDetached(...generations.flatMap((models) => Object.values(models)));
  });
});
