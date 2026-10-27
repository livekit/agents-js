// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Ported from Python `tests/test_amd_detector.py` (turn hooks, replies, and voicemail). */
import { AudioFrame } from '@livekit/rtc-node';
import { INVALID_SPAN_CONTEXT, trace } from '@opentelemetry/api';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ChatContext, ChatMessage } from '../../llm/chat_context.js';
import type { LLMStream } from '../../llm/llm.js';
import { ToolContext, type ToolContextLike, tool } from '../../llm/tool_context.js';
import { delay } from '../../utils.js';
import { Agent } from '../agent.js';
import type { AgentActivity } from '../agent_activity.js';
import { AgentSession } from '../agent_session.js';
import { AgentSessionEventTypes, type SpeechCreatedEvent } from '../events.js';
import { SpeechHandle } from '../speech_handle.js';
import type { TurnHooks } from '../turn_hooks.js';
import {
  ClassifierLLM,
  CustomerAgent,
  RecordingLLM,
  commit,
  commitTurn,
  endOfTurn,
  eventually,
  internals,
  nextDeadline,
  running,
  sessionOf,
  speechEnded,
  speechStarted,
  waitFor,
} from './amd_test_utils.js';
import {
  AMD,
  DEFAULT_HUMAN_INSTRUCTIONS,
  DEFAULT_IVR_INSTRUCTIONS,
  DEFAULT_SCREENING_INSTRUCTIONS,
  DEFAULT_VOICEMAIL_INSTRUCTIONS,
} from './detector.js';
import {
  AMDCategory,
  type AMDCompletedEvent,
  AMDLifecycle,
  type AMDPredictionEvent,
  AMDReason,
  createAMDPredictionEvent,
} from './events.js';

function messages(chatCtx: ChatContext): ChatMessage[] {
  return chatCtx.items.filter((item): item is ChatMessage => item instanceof ChatMessage);
}

function toolIds(toolCtx: ToolContextLike | undefined): string[] {
  if (toolCtx === undefined) {
    return [];
  }
  const ctx = toolCtx instanceof ToolContext ? toolCtx : new ToolContext(toolCtx as never);
  return Object.keys(ctx.functionTools);
}

function noPendingSpeech(activity: AgentActivity): boolean {
  const state = activity as unknown as {
    speechQueue: { size(): number };
    _currentSpeech?: SpeechHandle;
  };
  return (
    state.speechQueue.size() === 0 &&
    (state._currentSpeech === undefined || state._currentSpeech.done())
  );
}

function controlPrefix(detector: AMD): string {
  return internals(detector).controlPrefix;
}

/** Wait for a SpeechHandle to finish, like Python's `await handle`. */
async function done(handle: SpeechHandle): Promise<void> {
  await new Promise<void>((resolve) => handle.addDoneCallback(() => resolve()));
}

/** A session with no AMD; closed when the test finishes. */
async function plainSession(agent: Agent, model: RecordingLLM): Promise<AgentSession> {
  const session = new AgentSession({ llm: model, turnHandling: { turnDetection: 'manual' } });
  onTestFinished(async () => {
    await session.close();
  });
  await session.start({ agent });
  return session;
}

/** Records each classifier stream so a test can see it was cancelled. */
class TrackingClassifierLLM extends ClassifierLLM {
  readonly streams: LLMStream[] = [];

  override chat(options: Parameters<ClassifierLLM['chat']>[0]): LLMStream {
    const stream = super.chat(options);
    this.streams.push(stream);
    return stream;
  }
}

function aborted(stream: LLMStream): boolean {
  return (stream as unknown as { abortController: AbortController }).abortController.signal.aborted;
}

function setAudioDuration(activity: AgentActivity, duration: number): void {
  (activity.tts as unknown as { audioDuration: number }).audioDuration = duration;
}

describe('AMD detector turns', () => {
  it('prediction event carries its stage', () => {
    let event = createAMDPredictionEvent({
      category: AMDCategory.WAIT,
      reason: AMDReason.PREDICTION,
      transcript: 'hello',
      speechDuration: 0,
      delay: 0,
    });
    expect(event.stage).toBe(AMDCategory.UNCERTAIN);
    expect(JSON.parse(JSON.stringify(event)).stage).toBe('uncertain');

    event = createAMDPredictionEvent({
      category: AMDCategory.MACHINE_VM,
      stage: AMDCategory.MACHINE_VM,
      reason: AMDReason.PREDICTION,
      transcript: 'hello',
      speechDuration: 0,
      delay: 0,
    });
    expect({ ...event }.stage).toBe('machine-vm');
  });

  it.each([false, true])(
    'turn hooks control replies without AMD (allowReply=%s)',
    async (allowReply) => {
      const replyTool = tool({
        name: 'reply_tool',
        description: 'A tool available only to the generated reply.',
        execute: async () => 'done',
      });
      const replies: SpeechHandle[] = [];
      const calls: string[] = [];
      const model = new RecordingLLM();
      const agent = new CustomerAgent();
      const session = await plainSession(agent, model);
      const activity = session._activity!;

      const hooks: TurnHooks = {
        replyInstructions: undefined,
        onUserTurnCommitted(transcript, endOfTurnDelay) {
          expect(transcript).toBe('hello');
          expect(endOfTurnDelay).toBeUndefined();
          expect(agent.hooks).toEqual([]);
          calls.push('user_turn_committed');
          return hooks;
        },
        onUserTurnCompleted() {
          expect(activity._userTurnCompletedTask!.done).toBe(true);
          calls.push('user_turn_completed');
        },
        onReplyGeneration(tools) {
          calls.push('reply_generation');
          return new ToolContext([...tools.tools, replyTool]);
        },
        async shouldReply(chatCtx) {
          expect(agent.hooks).toHaveLength(1);
          calls.push('should_reply');
          chatCtx.addMessage({ role: 'system', content: 'Turn instructions' });
          return allowReply;
        },
        onAgentTurnCommitted(handle) {
          calls.push('agent_turn_committed');
          replies.push(handle);
        },
      };

      expect(session.amd).toBeNull();
      session._turnHooks = hooks;
      void activity.onEndOfTurn(endOfTurn());
      await waitFor(activity._userTurnCompletedTask!.result);
      await eventually(() => calls.includes('user_turn_completed'));

      if (allowReply) {
        expect(calls).toEqual([
          'user_turn_committed',
          'should_reply',
          'reply_generation',
          'agent_turn_committed',
          'user_turn_completed',
        ]);
        const call = await model.calls.get();
        expect(messages(call.chatCtx).some((m) => m.textContent === 'Turn instructions')).toBe(
          true,
        );
        expect(toolIds(call.toolCtx)).toContain('reply_tool');
        expect(replies).toHaveLength(1);
        await waitFor(done(replies[0]!));
      } else {
        expect(calls).toEqual(['user_turn_committed', 'should_reply', 'user_turn_completed']);
        expect(model.calls.empty).toBe(true);
        expect(replies).toEqual([]);
      }
      expect(agent.hooks).toHaveLength(1);
      expect(messages(agent.chatCtx).some((m) => m.textContent === 'Turn instructions')).toBe(
        false,
      );
    },
  );

  it.each(['adopted', 'replaced', 'suppressed'])(
    'preemptive generation commits only the accepted reply (%s)',
    async (outcome) => {
      const hooks = {
        replyInstructions: undefined,
        onUserTurnCommitted: vi.fn((): TurnHooks => hooks),
        onUserTurnCompleted: vi.fn(),
        onReplyGeneration: vi.fn((tools: ToolContext) => tools),
        shouldReply: vi.fn(async (chatCtx: ChatContext) => {
          if (outcome === 'replaced') {
            chatCtx.addMessage({ role: 'system', content: DEFAULT_HUMAN_INSTRUCTIONS });
          }
          return outcome !== 'suppressed';
        }),
        onAgentTurnCommitted: vi.fn(),
      } satisfies TurnHooks;
      const model = new RecordingLLM();
      const session = await plainSession(
        new Agent({ instructions: 'Call about an appointment.' }),
        model,
      );
      session._turnHooks = hooks;
      session.sessionOptions.turnHandling.preemptiveGeneration.enabled = true;
      const activity = session._activity!;
      activity.onPreemptiveGeneration({
        newTranscript: 'hello',
        transcriptConfidence: 1,
        startedSpeakingAt: undefined,
      });
      const generation = (
        activity as unknown as { _preemptiveGeneration?: { speechHandle: SpeechHandle } }
      )._preemptiveGeneration;
      expect(generation).toBeDefined();
      const preemptive = generation!.speechHandle;
      await model.calls.get();

      expect(hooks.onReplyGeneration).toHaveBeenCalledTimes(1);
      expect(hooks.onUserTurnCommitted).not.toHaveBeenCalled();
      expect(hooks.onUserTurnCompleted).not.toHaveBeenCalled();
      expect(hooks.shouldReply).not.toHaveBeenCalled();
      expect(hooks.onAgentTurnCommitted).not.toHaveBeenCalled();

      void activity.onEndOfTurn(endOfTurn());
      await waitFor(activity._userTurnCompletedTask!.result);
      await eventually(() => hooks.onUserTurnCompleted.mock.calls.length > 0);

      expect(hooks.onUserTurnCommitted).toHaveBeenCalledOnce();
      expect(hooks.onUserTurnCommitted).toHaveBeenCalledWith('hello', undefined);
      expect(hooks.onUserTurnCompleted).toHaveBeenCalledOnce();
      expect(hooks.onUserTurnCompleted).toHaveBeenCalledWith();
      expect(hooks.shouldReply).toHaveBeenCalledOnce();
      if (outcome === 'suppressed') {
        expect(hooks.onAgentTurnCommitted).not.toHaveBeenCalled();
      } else {
        expect(hooks.onAgentTurnCommitted).toHaveBeenCalledOnce();
        const reply = hooks.onAgentTurnCommitted.mock.calls[0]![0] as SpeechHandle;
        expect(reply === preemptive).toBe(outcome === 'adopted');
        await waitFor(done(reply));
      }
      expect(preemptive.interrupted).toBe(outcome !== 'adopted');
      if (outcome === 'replaced') {
        await model.calls.get();
      }
      expect(hooks.onReplyGeneration).toHaveBeenCalledTimes(outcome === 'replaced' ? 2 : 1);
      expect(model.calls.empty).toBe(true);
    },
  );

  it('cancel pending speech includes preemptive and queued speech', async () => {
    const { session } = await running();
    const activity = session._activity!;
    session.sessionOptions.turnHandling.preemptiveGeneration.enabled = true;
    activity.onPreemptiveGeneration({
      newTranscript: 'hello',
      transcriptConfidence: 1,
      startedSpeakingAt: undefined,
    });
    const state = activity as unknown as {
      _preemptiveGeneration?: { speechHandle: SpeechHandle };
    };
    expect(state._preemptiveGeneration).toBeDefined();
    const preemptive = state._preemptiveGeneration!.speechHandle;
    const queued = session.say('Please call me back.');

    activity._cancelPendingSpeeches();

    await waitFor(Promise.all([done(preemptive), done(queued)]));
    expect(preemptive.interrupted && queued.interrupted).toBe(true);
    expect(state._preemptiveGeneration).toBeUndefined();
    expect(session.output.audio!.capturedPlayoutSegments).toBe(0);
  });

  it.each(['reused', 'inference_error', 'inference_timeout'])(
    'a fallback is uncertain and a reuse repeats the prediction (%s)',
    async (reason) => {
      const { detector, session, classifier } = await running({ inferenceTimeout: 20 });
      const amd = internals(detector);
      const events: AMDPredictionEvent[] = [];
      detector.on('amd_prediction', (event) => events.push(event));
      await commit(detector, session, classifier);
      classifier.prediction(1, AMDCategory.MACHINE_VM);
      await waitFor(amd._shouldReply(1, new ChatContext()));
      const first = events[events.length - 1]!;
      expect(first.stage).toBe(AMDCategory.MACHINE_VM);

      if (reason === 'reused') {
        commitTurn(detector, endOfTurn(''));
      } else {
        await commit(detector, session, classifier);
        if (reason === 'inference_error') {
          classifier.respond(2, 'invalid JSON');
        }
      }
      await waitFor(amd._shouldReply(2, new ChatContext()));
      const fallback = amd.turns.get(2)!.prediction!;
      expect(fallback).not.toBeNull();
      expect(events).toHaveLength(2);
      expect(fallback.reason).toBe(reason);
      // a turn with no prediction is unknown; an empty turn repeats the last one
      const expected = reason === 'reused' ? AMDCategory.MACHINE_VM : AMDCategory.UNCERTAIN;
      expect(fallback.category).toBe(expected);
      expect(fallback.stage).toBe(first.stage);

      await detector.aclose();
      const completed = await detector.execute();
      const latest = reason === 'reused' ? first : fallback;
      expect(completed.lastPrediction).toEqual(latest);
    },
  );

  it('customer hook and prediction overlap controls are temporary', async () => {
    const agent = new CustomerAgent();
    agent.hookRelease.clear();
    const { detector, session, classifier, model } = await running({ agent });
    let completed: AMDCompletedEvent | undefined;
    const execution = detector.execute().then((event) => {
      completed = event;
      return event;
    });
    const info = endOfTurn();
    info.endOfUtteranceDelay = 500;
    let turnIdAtHook: number | undefined;
    void agent.hookStarted.wait().then(() => {
      turnIdAtHook = internals(detector)._turnId;
    });
    void session._activity!.onEndOfTurn(info);
    expect(internals(detector)._turnId).toBe(1);
    const request = await classifier.request();
    await waitFor(agent.hookStarted.wait());
    // the turn is committed to AMD before the customer hook runs
    expect(turnIdAtHook).toBe(1);
    expect(request.currentTurn.extra.turn_id).toBe(1);
    expect(request.currentTurn.textContent).toBe('hello');
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await eventually(() => internals(detector).turns.get(1)!.prediction !== null);
    expect(model.calls.empty).toBe(true);
    agent.hookRelease.set();
    const call = await model.calls.get();
    const msgs = messages(call.chatCtx);
    expect(msgs[msgs.length - 1]!.textContent).toBe(DEFAULT_SCREENING_INSTRUCTIONS);
    expect(msgs.some((m) => m.textContent === 'Customer hook edit')).toBe(true);
    expect(msgs.some((m) => m.textContent === 'hello')).toBe(true);
    expect(agent.hooks).toHaveLength(1);
    expect(completed).toBeUndefined();
    await eventually(() => noPendingSpeech(session._activity!));
    expect(agent.chatCtx.items.some((m) => m.id.startsWith(controlPrefix(detector)))).toBe(false);
    await detector.aclose();
    expect((await execution).reason).toBe(AMDReason.CANCELLED);
  });

  it.each([
    [AMDCategory.MACHINE_SCREENING, DEFAULT_SCREENING_INSTRUCTIONS],
    [AMDCategory.MACHINE_VM, DEFAULT_VOICEMAIL_INSTRUCTIONS],
    [AMDCategory.HUMAN, DEFAULT_HUMAN_INSTRUCTIONS],
  ])(
    'turn hooks keep their turn while an older hook is blocked (%s)',
    async (category, instructions) => {
      const agent = new CustomerAgent();
      agent.hookRelease.clear();
      const { detector, session, classifier, model } = await running({ agent });
      const activity = session._activity!;
      try {
        await commit(detector, session, classifier, { reply: true });
        await waitFor(agent.hookStarted.wait());
        classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
        await eventually(() => internals(detector).turns.get(1)!.prediction !== null);

        void activity.onEndOfTurn(endOfTurn('Can you hear me?'));
        expect((await classifier.request()).currentTurn.extra.turn_id).toBe(2);
        classifier.prediction(2, category);
        await eventually(() => internals(detector).turns.get(2)!.prediction !== null);
        if (category === AMDCategory.HUMAN) {
          await waitFor(detector.execute());
          expect(session.amd).toBeNull();
        }
        expect(agent.hooks).toHaveLength(1);
        expect(model.calls.empty).toBe(true);
      } finally {
        agent.hookRelease.set();
      }

      await waitFor(activity._userTurnCompletedTask!.result);
      const call = await model.calls.get();
      const msgs = messages(call.chatCtx);
      expect(msgs[msgs.length - 1]!.textContent).toBe(instructions);
      expect(msgs.some((m) => m.textContent === 'Can you hear me?')).toBe(true);
      expect(agent.hooks).toHaveLength(2);
      if (category === AMDCategory.MACHINE_VM) {
        await eventually(() => internals(detector).voicemailMessagePlayed);
      }
      await eventually(() => noPendingSpeech(activity));
      expect(model.calls.empty).toBe(true);
    },
  );

  it('turn ids are local to each AMD run', async () => {
    const session = await plainSession(new CustomerAgent(), new RecordingLLM());
    const activity = session._activity!;
    for (let i = 0; i < 2; i++) {
      void activity.onEndOfTurn(endOfTurn('hello', { skipReply: true }));
      await waitFor(activity._userTurnCompletedTask!.result);
      const classifier = new ClassifierLLM();
      const detector = new AMD(session, {
        llm: classifier,
        stt: null,
        machineSilenceThreshold: 0,
      });
      await detector.start();
      try {
        await eventually(() => detector.lifecycle === AMDLifecycle.ACTIVE);
        const hooks = await commit(detector, session, classifier);
        expect(internals(detector)._turnId).toBe(1);
        classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
        expect(await hooks!.shouldReply(new ChatContext())).toBe(true);
      } finally {
        await detector.aclose();
      }
    }
  });

  it.each([AMDCategory.MACHINE_SCREENING, AMDCategory.MACHINE_UNAVAILABLE])(
    'AMD turn hooks retain the adopted user turn span (%s)',
    async (category) => {
      const { detector, session, classifier, model } = await running();
      const span = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
      vi.spyOn(span, 'isRecording').mockReturnValue(true);
      const end = vi.spyOn(span, 'end');
      const info = endOfTurn();
      info.userTurnSpan = span;
      void session._activity!.onEndOfTurn(info);
      await classifier.request();
      await waitFor((session.currentAgent as CustomerAgent).hookStarted.wait());
      await delay(0);

      expect(info.userTurnSpanAdopted).toBe(true);
      expect(end).not.toHaveBeenCalled();
      expect(model.calls.empty).toBe(true);

      classifier.prediction(1, category);
      await waitFor(session._activity!._userTurnCompletedTask!.result);
      expect(end).toHaveBeenCalledOnce();
      expect(end).toHaveBeenCalledWith();
      expect(info.userTurnSpanAdopted).toBe(false);
      if (category === AMDCategory.MACHINE_UNAVAILABLE) {
        expect((await detector.execute()).category).toBe(category);
        expect(model.calls.empty).toBe(true);
      } else {
        const call = await model.calls.get();
        const items = call.chatCtx.items;
        expect((items[items.length - 1] as ChatMessage).textContent).toBe(
          DEFAULT_SCREENING_INSTRUCTIONS,
        );
      }
    },
  );

  it('voicemail sends one delivered message and records playback', async () => {
    const { detector, session, classifier, model } = await running();
    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    await model.calls.get();
    await eventually(() => internals(detector).voicemailMessagePlayed);
    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(2, AMDCategory.MACHINE_VM);
    await eventually(() => internals(detector).turns.get(2)!.prediction !== null);
    await waitFor(session._activity!._userTurnCompletedTask!.result);
    expect(model.calls.empty).toBe(true);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
    expect(
      messages(session.currentAgent.chatCtx)
        .filter((m) => m.role === 'user')
        .map((m) => m.textContent),
    ).toEqual(['hello', 'hello']);
  });

  it('superseded voicemail reply does not consume the stage message', async () => {
    const { detector, session, classifier } = await running();
    const activity = session._activity!;
    const speeches: SpeechHandle[] = [];
    const advances: Promise<boolean>[] = [];

    session.on(AgentSessionEventTypes.SpeechCreated, (event: SpeechCreatedEvent) => {
      speeches.push(event.speechHandle);
      if (speeches.length === 1) {
        advances.push(activity.onEndOfTurn(endOfTurn('Please leave your message.')));
      }
    });
    await commit(detector, session, classifier, { reply: true });
    const firstTurnTask = activity._userTurnCompletedTask!;
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    expect((await classifier.request()).currentTurn.extra.turn_id).toBe(2);
    expect(await advances[0]).toBe(true);
    await waitFor(firstTurnTask.result);
    expect(speeches).toHaveLength(1);
    // JS interrupts the superseded reply when the next turn task starts, not when the first ends
    await eventually(() => speeches[0]!.interrupted);
    expect(internals(detector).voicemailHandle).toBeUndefined();

    classifier.prediction(2, AMDCategory.MACHINE_VM);
    await waitFor(activity._userTurnCompletedTask!.result);
    expect(speeches).toHaveLength(2);
    expect(internals(detector).voicemailHandle).toBe(speeches[1]);
    await waitFor(done(speeches[1]!));
    expect(speeches[1]!.interrupted).toBe(false);
    expect(internals(detector).voicemailMessagePlayed).toBe(true);
    expect(session.output.audio!.capturedPlayoutSegments).toBe(1);

    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(3, AMDCategory.MACHINE_VM);
    await waitFor(activity._userTurnCompletedTask!.result);
    expect(speeches).toHaveLength(2);
    expect(session.output.audio!.capturedPlayoutSegments).toBe(1);
  });

  it.each(['before_new_handle', 'after_new_handle'])(
    'stale voicemail handle does not clear a newer reservation (%s)',
    async (staleCommit) => {
      const { detector, session, classifier } = await running();
      const first = (await commit(detector, session, classifier))!;
      classifier.prediction(1, AMDCategory.MACHINE_VM);
      expect(await first.shouldReply(new ChatContext())).toBe(true);
      const second = (await commit(detector, session, classifier))!;
      classifier.prediction(2, AMDCategory.MACHINE_VM);
      expect(await second.shouldReply(new ChatContext())).toBe(true);

      const oldHandle = SpeechHandle.create();
      oldHandle.interrupt();
      const newHandle = SpeechHandle.create();
      if (staleCommit === 'before_new_handle') {
        first.onAgentTurnCommitted(oldHandle);
      }
      second.onAgentTurnCommitted(newHandle);
      if (staleCommit === 'after_new_handle') {
        first.onAgentTurnCommitted(oldHandle);
      }
      expect(internals(detector).voicemailHandle).toBe(newHandle);

      const output = session.output.audio!;
      await output.captureFrame(new AudioFrame(new Int16Array(24), 24_000, 1, 24));
      output.flush();
      await output.waitForPlayout();
      const completed = done(newHandle);
      newHandle._markDone();
      oldHandle._markDone();
      await waitFor(completed);
      expect(internals(detector).voicemailMessagePlayed).toBe(true);

      const third = (await commit(detector, session, classifier))!;
      classifier.prediction(3, AMDCategory.MACHINE_VM);
      expect(await third.shouldReply(new ChatContext())).toBe(false);
    },
  );

  it.each(['played', 'interrupted', 'failed', 'no_audio', 'closed'])(
    'voicemail playback is recorded by its handle (%s)',
    async (outcome) => {
      const { detector, session, classifier } = await running();
      const hooks = await commit(detector, session, classifier);
      expect(hooks).toBeDefined();
      classifier.prediction(1, AMDCategory.MACHINE_VM);
      expect(await hooks!.shouldReply(new ChatContext())).toBe(true);

      const handle = SpeechHandle.create();
      hooks!.onAgentTurnCommitted(handle);
      if (outcome !== 'no_audio') {
        const output = session.output.audio!;
        await output.captureFrame(new AudioFrame(new Int16Array(24), 24_000, 1, 24));
        output.flush();
        await output.waitForPlayout();
      }

      expect(internals(detector).voicemailMessagePlayed).toBe(false);
      if (outcome === 'interrupted') {
        handle.interrupt();
      } else if (outcome === 'closed') {
        await detector.aclose();
      }

      const completed = done(handle);
      handle._markDone(outcome === 'failed' ? new Error('speech failed') : undefined);
      await waitFor(completed);
      expect(internals(detector).voicemailMessagePlayed).toBe(outcome === 'played');
    },
  );

  it('voicemail handle commit does not signal a prediction or update idle', async () => {
    const { detector, session, classifier } = await running();
    const hooks = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    expect(await hooks.shouldReply(new ChatContext())).toBe(true);
    const predictionChanged = (detector as unknown as { predictionChanged: { set(): void } })
      .predictionChanged;
    const notifyPrediction = vi.spyOn(predictionChanged, 'set');
    const updateIdle = vi.spyOn(internals(detector), '_updateIdle');

    const handle = SpeechHandle.create();
    hooks.onAgentTurnCommitted(handle);

    expect(notifyPrediction).not.toHaveBeenCalled();
    expect(updateIdle).not.toHaveBeenCalled();
    const completed = done(handle);
    handle._markDone();
    await waitFor(completed);
  });

  it('voicemail idle defaults to one minute after playback', async () => {
    const { detector, session, classifier, model } = await running();
    expect(nextDeadline(detector)).toBeDefined();
    expect(nextDeadline(detector)! - performance.now()).toBeCloseTo(10_000, -2);
    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    await model.calls.get();
    await eventually(
      () => internals(detector).voicemailMessagePlayed && noPendingSpeech(session._activity!),
    );
    expect(nextDeadline(detector)).toBeDefined();
    expect(nextDeadline(detector)! - performance.now()).toBeCloseTo(60_000, -2);
    await detector.aclose();
    expect(nextDeadline(detector)).toBeUndefined();
  });

  it('late post-voicemail menu uses the normal IVR idle timeout', async () => {
    const { detector, session, classifier, model } = await running({
      idleTimeout: 30,
      voicemailIdleTimeout: 1_000,
    });
    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    await model.calls.get();
    await eventually(
      () => internals(detector).voicemailMessagePlayed && noPendingSpeech(session._activity!),
    );
    const voicemailDeadline = nextDeadline(detector);
    expect(voicemailDeadline).toBeDefined();
    await delay(60);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);

    speechStarted(detector);
    expect(nextDeadline(detector)).toBeDefined();
    expect(nextDeadline(detector)!).toBeGreaterThan(voicemailDeadline!);
    speechEnded(detector, 0);
    const menu =
      'To replay your message, press 1. To continue recording, press 2. ' +
      'To delete and re-record your message, press 3. For delivery options, press 4. ' +
      'To send a fax, press 6. To cancel this message, press star. ' +
      'To send this message now, press pound or hang up.';
    void session._activity!.onEndOfTurn(endOfTurn(menu));
    await classifier.request();
    classifier.prediction(2, AMDCategory.MACHINE_IVR);
    const call = await model.calls.get();
    const items = call.chatCtx.items;
    expect((items[items.length - 1] as ChatMessage).textContent!).toMatch(
      new RegExp(`^${DEFAULT_IVR_INSTRUCTIONS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    expect(toolIds(call.toolCtx)).toContain('send_dtmf_events');
    const result = await waitFor(detector.execute(), 500);
    expect(result.reason).toBe(AMDReason.IDLE_TIMEOUT);
    expect(result.category).toBe(AMDCategory.MACHINE_IVR);
    expect(result.voicemailMessagePlayed).toBe(true);
  });

  it.each([
    [false, AMDCategory.MACHINE_UNAVAILABLE, AMDCategory.MACHINE_VM],
    [true, AMDCategory.MACHINE_UNAVAILABLE, AMDCategory.MACHINE_IVR],
    [true, AMDCategory.HUMAN, AMDCategory.HUMAN],
  ])(
    'a goodbye after the voicemail message keeps the stage (menu=%s, last=%s)',
    async (menu, last, expected) => {
      const { detector, session, classifier, model } = await running();
      await commit(detector, session, classifier, { reply: true });
      classifier.prediction(1, AMDCategory.MACHINE_VM);
      await model.calls.get();
      await eventually(
        () => internals(detector).voicemailMessagePlayed && noPendingSpeech(session._activity!),
      );
      if (menu) {
        const hooks = await commit(detector, session, classifier);
        classifier.prediction(2, AMDCategory.MACHINE_IVR);
        expect(hooks).toBeDefined();
        await hooks!.shouldReply(new ChatContext());
      }
      await commit(detector, session, classifier);
      classifier.prediction(internals(detector)._turnId, last);

      const result = await waitFor(detector.execute());
      expect(result.reason).toBe(AMDReason.FINISHED);
      // the box's goodbye is not an unreachable call; a person who picks up is human
      expect(result.category).toBe(expected);
      expect(result.voicemailMessagePlayed).toBe(true);
    },
  );

  it.each([AMDCategory.MACHINE_VM, AMDCategory.MACHINE_IVR])(
    'late prediction preserves stage and idle timer (%s)',
    async (category) => {
      const classifier = new TrackingClassifierLLM();
      const { detector, session } = await running({
        classifier,
        idleTimeout: 1_000,
        voicemailIdleTimeout: 2_000,
        inferenceTimeout: 10,
      });
      const events: AMDPredictionEvent[] = [];
      detector.on('amd_prediction', (event) => events.push(event));
      const first = (await commit(detector, session, classifier))!;
      const previous =
        category === AMDCategory.MACHINE_VM ? AMDCategory.MACHINE_IVR : AMDCategory.MACHINE_VM;
      classifier.prediction(1, previous);
      expect(await first.shouldReply(new ChatContext())).toBe(true);
      const second = (await commit(detector, session, classifier))!;
      await second.shouldReply(new ChatContext());
      const deadline = nextDeadline(detector);
      // the timed-out classification was cancelled before the provider answered
      const lateStream = classifier.streams.find(
        (stream) => (stream.chatCtx.items.at(-1) as ChatMessage | undefined)?.extra.turn_id === 2,
      );
      expect(lateStream).toBeDefined();
      expect(aborted(lateStream!)).toBe(true);
      classifier.prediction(2, category);
      await delay(0);
      expect(events[events.length - 1]!.reason).toBe(AMDReason.INFERENCE_TIMEOUT);
      expect(events).toHaveLength(2);
      expect(internals(detector)._state).toBe(previous);
      expect(nextDeadline(detector)).toBe(deadline);
      expect(nextDeadline(detector)).toBeDefined();
      const expected = previous === AMDCategory.MACHINE_VM ? 2_000 : 1_000;
      expect(nextDeadline(detector)! - performance.now()).toBeCloseTo(expected, -2);
    },
  );

  it('voicemail idle does not extend the hard timeout', async () => {
    const { detector, session, classifier } = await running({ timeout: 80 });
    await commit(detector, session, classifier);
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    const result = await waitFor(detector.execute());
    expect(result.category).toBe(AMDCategory.MACHINE_VM);
    expect(result.reason).toBe(AMDReason.TIMEOUT);
    expect(nextDeadline(detector)).toBeUndefined();
  });

  it.each([0, -1])(
    'nonpositive voicemail idle timeout is rejected (%s)',
    (voicemailIdleTimeout) => {
      expect(() => new AMD(new AgentSession(), { voicemailIdleTimeout })).toThrow(/timeouts/);
    },
  );

  const takeoverCases = [
    [AMDCategory.MACHINE_VM, "I'm not available right now. Please leave a message after the beep."],
    [AMDCategory.MACHINE_SCREENING, 'Please state your name and the reason you are calling.'],
    [AMDCategory.MACHINE_IVR, 'Say who you want to speak to.'],
  ] as const;
  const takeoverMatrix = takeoverCases.flatMap(([category, prompt]) =>
    [false, true].flatMap((hookFinishesAfterCleanup) =>
      [undefined, 'Greet the person and ask whether they can discuss the appointment.'].map(
        (humanInstructions) =>
          [category, prompt, hookFinishesAfterCleanup, humanInstructions] as const,
      ),
    ),
  );

  it.each(takeoverMatrix)(
    'human takeover updates the reply context during machine speech (%s, %s, hookFinishesAfterCleanup=%s, humanInstructions=%s)',
    async (category, prompt, hookFinishesAfterCleanup, humanInstructions) => {
      const agent = new CustomerAgent();
      const { detector, session, classifier, model } = await running({
        agent,
        ...(humanInstructions !== undefined ? { humanInstructions } : {}),
      });
      if (humanInstructions !== undefined) {
        (model as unknown as { responseMap: Map<string, Record<string, unknown>> }).responseMap.set(
          humanInstructions,
          {
            input: humanInstructions,
            type: 'llm',
            content: 'Hello, can we discuss your appointment?',
            ttft: 0,
            duration: 0,
          },
        );
      }
      const activity = session._activity!;
      setAudioDuration(activity, 10_000);
      void activity.onEndOfTurn(endOfTurn(prompt));
      await classifier.request();
      classifier.prediction(1, category);
      await model.calls.get();
      await eventually(() => session.agentState === 'speaking');
      const machineSpeech = activity.currentSpeech;
      expect(machineSpeech !== undefined && !machineSpeech.done()).toBe(true);
      setAudioDuration(activity, 50);

      agent.hookStarted.clear();
      if (hookFinishesAfterCleanup) {
        agent.hookRelease.clear();
      }
      void activity.onEndOfTurn(endOfTurn('Can you hear me?'));
      await classifier.request();
      await waitFor(agent.hookStarted.wait());
      classifier.prediction(2, AMDCategory.HUMAN);
      if (hookFinishesAfterCleanup) {
        await waitFor(detector.execute());
        expect(session.amd).toBeNull();
        expect(session._turnHooks).toBeUndefined();
        agent.hookRelease.set();
      }

      const call = await model.calls.get();
      const msgs = messages(call.chatCtx);
      const controls = msgs.filter((m) => m.id.startsWith(controlPrefix(detector)));
      expect(controls).toHaveLength(1);
      expect(controls[0]!.extra.amd_stage).toBe('human');
      expect(controls[0]).toBe(msgs[msgs.length - 1]);
      expect(controls[0]!.textContent).toBe(humanInstructions ?? DEFAULT_HUMAN_INSTRUCTIONS);
      expect(msgs.some((m) => m.textContent === 'Customer hook edit')).toBe(true);
      expect(msgs.some((m) => m.textContent === prompt)).toBe(true);
      expect(msgs.some((m) => m.textContent === 'Can you hear me?')).toBe(true);
      expect(machineSpeech!.interrupted).toBe(true);
      expect(agent.hooks).toHaveLength(2);
      const result = await waitFor(detector.execute());
      expect(result.category).toBe(AMDCategory.HUMAN);
      expect(result.voicemailMessagePlayed).toBe(false);
      await eventually(() => noPendingSpeech(activity));
      expect(agent.chatCtx.items.some((m) => m.id.startsWith(controlPrefix(detector)))).toBe(false);

      void activity.onEndOfTurn(endOfTurn('Thank you.'));
      const normal = await model.calls.get();
      expect(normal.chatCtx.items.some((m) => m.id.startsWith(controlPrefix(detector)))).toBe(
        false,
      );
      expect(internals(detector)._turnId).toBe(2);
    },
  );

  it.each([false, true])(
    'human instructions are skipped without a machine stage (uncertainFirst=%s)',
    async (uncertainFirst) => {
      const { detector, session, classifier, model } = await running({
        humanInstructions: 'The automated screening has finished.',
      });
      if (uncertainFirst) {
        const hooks = (await commit(detector, session, classifier))!;
        classifier.prediction(1, AMDCategory.UNCERTAIN);
        expect(await hooks.shouldReply(new ChatContext())).toBe(true);
      }

      await commit(detector, session, classifier, { reply: true });
      classifier.prediction(internals(detector)._turnId, AMDCategory.HUMAN);
      const call = await model.calls.get();
      const msgs = messages(call.chatCtx);
      expect(msgs.some((m) => m.id.startsWith(controlPrefix(detector)))).toBe(false);
      expect(msgs.some((m) => m.textContent === 'Customer hook edit')).toBe(true);
      expect(msgs.some((m) => m.textContent === 'hello')).toBe(true);
      expect((await detector.execute()).category).toBe(AMDCategory.HUMAN);
      await eventually(() => noPendingSpeech(sessionOf(detector)._activity!));
    },
  );
});
