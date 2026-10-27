// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Ported from Python `tests/test_amd_example.py`. */
import * as agents from '@livekit/agents';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { MyAgent, entry } from './amd.js';

// The example and the AMD harness load from the agents source tree, so their classes match.
// The specifiers are not literals: the examples typecheck (rootDir `src`) must not follow them.
const source = vi.hoisted(() => ({
  load: async <T>(path: string): Promise<T> =>
    (await import(/* @vite-ignore */ `../../../agents/src/${path}`)) as T,
}));

// The `voice` and `inference` namespaces are plain copies a test can patch, like monkeypatch.
vi.mock('@livekit/agents', async () => {
  const actual = await source.load<typeof agents>('index.js');
  return { ...actual, voice: { ...actual.voice }, inference: { ...actual.inference } };
});

vi.mock('@livekit/noise-cancellation-node', () => ({
  BackgroundVoiceCancellation: vi.fn(() => ({})),
}));

const sip = vi.hoisted(() => ({ createSipParticipant: vi.fn() }));

vi.mock('livekit-server-sdk', () => ({
  SipClient: vi.fn(function () {
    return { createSipParticipant: sip.createSipParticipant };
  }),
  RoomServiceClient: vi.fn(function () {
    return { deleteRoom: vi.fn(async () => {}) };
  }),
}));

const jobContext = vi.hoisted(() => ({ current: undefined as unknown }));

// `getJobContext` serves both the end-call tool and `sendDtmfEvents`.
vi.mock('../../../agents/src/job.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getJobContext: vi.fn((required = true) => {
      if (jobContext.current === undefined && required) {
        throw new Error('no job context found');
      }
      return jobContext.current;
    }),
  };
});

type AMD = agents.voice.AMD;
type AgentSession = agents.voice.AgentSession;
type AMDCompletedEvent = agents.voice.AMDCompletedEvent;
type ReplyCall = { toolCtx: unknown };

/** The harness and AMD internals this test uses (`agents/src/voice/amd/amd_test_utils.ts`). */
interface Harness {
  running(options: Record<string, unknown>): Promise<{
    detector: AMD;
    session: AgentSession;
    classifier: {
      prediction(turnId: number, category: string): void;
      request(): Promise<unknown>;
    };
    model: { calls: { get(): Promise<ReplyCall>; empty: boolean } };
  }>;
  commit(...args: unknown[]): Promise<unknown>;
  endOfTurn(transcript: string): Parameters<AgentActivity['onEndOfTurn']>[0];
  eventually(predicate: () => boolean): Promise<void>;
  waitFor<T>(promise: Promise<T>): Promise<T>;
  internals(detector: AMD): {
    voicemailMessagePlayed: boolean;
    _getInstructions(stage: string): string;
  };
  nextDeadline(detector: AMD): number | undefined;
  speechStarted(detector: AMD): void;
  speechEnded(detector: AMD, silenceDuration: number): void;
}
type AgentActivity = NonNullable<AgentSession['_activity']>;

const harness = await source.load<Harness>('voice/amd/amd_test_utils.js');
const { DEFAULT_VOICEMAIL_INSTRUCTIONS } = await source.load<{
  DEFAULT_VOICEMAIL_INSTRUCTIONS: string;
}>('voice/amd/detector.js');
const {
  commit,
  endOfTurn,
  eventually,
  internals,
  nextDeadline,
  running,
  speechEnded,
  speechStarted,
  waitFor,
} = harness;
const { AMDCategory, AMDLifecycle, AMDReason } = agents.voice;

type Patchable = Record<string, unknown>;
const voice = agents.voice as unknown as Patchable;
const inference = agents.inference as unknown as Patchable;
const originals = { voice: { ...voice }, inference: { ...inference } };

afterEach(() => {
  Object.assign(voice, originals.voice);
  Object.assign(inference, originals.inference);
  jobContext.current = undefined;
  sip.createSipParticipant.mockReset();
  vi.unstubAllEnvs();
});

type FakeResponse = {
  input: string;
  type?: 'llm';
  content?: string;
  ttft?: number;
  duration?: number;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
};

function responses(model: unknown): Map<string, FakeResponse> {
  return (model as unknown as { responseMap: Map<string, FakeResponse> }).responseMap;
}

/** Ids of the tools a reply generation saw, like Python's `{tool.id for tool in call["tools"]}`. */
function toolIds(call: ReplyCall): Set<string> {
  const toolCtx = call.toolCtx as agents.llm.ToolContext | undefined;
  if (toolCtx === undefined) {
    return new Set();
  }
  return new Set([...toolCtx.tools, ...toolCtx.flatten()].map((tool) => tool.id));
}

function noPendingSpeech(activity: unknown): boolean {
  const state = activity as {
    speechQueue: { size(): number };
    _currentSpeech?: { done(): boolean };
  };
  return (
    state.speechQueue.size() === 0 &&
    (state._currentSpeech === undefined || state._currentSpeech.done())
  );
}

function useVirtualTime(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'],
    shouldAdvanceTime: true,
  });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** Await `promise` while virtual time advances, like an awaited future on a virtual loop. */
async function advancing<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  const started = performance.now();
  while (!settled && performance.now() - started < timeoutMs) {
    await vi.advanceTimersByTimeAsync(50);
  }
  if (!settled) {
    throw new Error('timed out');
  }
  return tracked;
}

describe('AMD telephony example', () => {
  it.each([
    'answered',
    'voicemail',
    'voicemail_menu',
    'voicemail_failed',
    'human_after_voicemail',
    'disconnected',
    'missing',
    'timeout',
    'cancelled',
    'console',
  ])('outbound call setup (%s)', async (outcome) => {
    vi.stubEnv('SIP_PHONE_NUMBER', '+15555550100');
    vi.stubEnv('SIP_PARTICIPANT_IDENTITY', 'callee');
    vi.stubEnv('LIVEKIT_OUTBOUND_TRUNK_ID', 'test-trunk');
    for (const name of ['STT', 'LLM', 'TTS']) {
      inference[name] = vi.fn(function () {
        return {};
      });
    }
    const session = {
      start: vi.fn(async () => {}),
      _roomIO: outcome === 'console' ? undefined : {},
    };
    voice.AgentSession = vi.fn(function () {
      return session;
    });
    const category =
      (
        {
          voicemail: AMDCategory.MACHINE_VM,
          voicemail_menu: AMDCategory.MACHINE_IVR,
          voicemail_failed: AMDCategory.MACHINE_VM,
        } as Record<string, agents.voice.AMDCategory>
      )[outcome] ?? AMDCategory.HUMAN;
    const result: AMDCompletedEvent = {
      type: 'amd_completed',
      category,
      reason: category === AMDCategory.HUMAN ? AMDReason.FINISHED : AMDReason.IDLE_TIMEOUT,
      voicemailMessagePlayed: ['voicemail', 'voicemail_menu', 'human_after_voicemail'].includes(
        outcome,
      ),
      lastPrediction: null,
    };
    const detector = {
      on: vi.fn(),
      start: vi.fn(async () => detector),
      execute: vi.fn(async () => result),
      aclose: vi.fn(async () => {}),
    };
    voice.AMD = vi.fn(function () {
      return detector;
    });

    const room = {
      name: 'test-room',
      remoteParticipants: new Map<string, { identity: string }>(),
      isConnected: outcome !== 'console',
    };
    sip.createSipParticipant.mockImplementation(async () => {
      expect(detector.start).toHaveBeenCalledOnce();
      if (outcome === 'timeout') {
        throw new Error('timed out');
      }
      if (outcome === 'cancelled') {
        throw new DOMException('This operation was aborted', 'AbortError');
      }
      if (outcome !== 'missing') {
        room.remoteParticipants.set('callee', { identity: 'callee' });
      }
      if (outcome === 'disconnected') {
        room.remoteParticipants.delete('callee');
      }
    });
    const ctx = {
      room,
      shutdown: vi.fn(),
      addShutdownCallback: vi.fn(),
    } as unknown as agents.JobContext;

    if (outcome === 'console') {
      await expect(entry(ctx)).rejects.toThrow('not started with a room');
      expect(detector.start).not.toHaveBeenCalled();
      expect(sip.createSipParticipant).not.toHaveBeenCalled();
      return;
    }
    if (outcome === 'cancelled') {
      await expect(entry(ctx)).rejects.toThrow('aborted');
    } else {
      await entry(ctx);
    }

    expect(sip.createSipParticipant).toHaveBeenCalledOnce();
    expect(sip.createSipParticipant.mock.calls[0]![3]).toMatchObject({ waitUntilAnswered: true });
    expect(detector.aclose).toHaveBeenCalledOnce();
    if (
      [
        'answered',
        'voicemail',
        'voicemail_menu',
        'voicemail_failed',
        'human_after_voicemail',
      ].includes(outcome)
    ) {
      expect(detector.execute).toHaveBeenCalledOnce();
      if (outcome === 'voicemail' || outcome === 'voicemail_menu') {
        expect(ctx.shutdown).toHaveBeenCalledExactlyOnceWith('voicemail completed');
      } else {
        expect(ctx.shutdown).not.toHaveBeenCalled();
      }
    } else {
      expect(detector.execute).not.toHaveBeenCalled();
      if (outcome === 'cancelled') {
        expect(ctx.shutdown).not.toHaveBeenCalled();
      } else {
        expect(ctx.shutdown).toHaveBeenCalledExactlyOnceWith(
          outcome === 'timeout' ? 'call not answered' : 'participant missing',
        );
      }
    }
  });

  it.for([false, true])(
    'voicemail keeps call open until AMD finishes (menu arrives: %s)',
    async (menuArrives, { skip }) => {
      if (menuArrives) {
        // Python's DTMF tool returns ToolResult(reply_required=False), so a send has no
        // follow-up reply and the IVR idle timeout completes AMD
        skip('waits for the #7340 ToolResult port: the JS DTMF tool still requests a reply');
      }
      const publishDtmf = vi.fn(async () => {});
      const job = {
        shutdown: vi.fn(),
        addShutdownCallback: vi.fn(),
        simulationContext: () => undefined,
        room: { localParticipant: { publishDtmf } },
      };
      useVirtualTime();
      const { detector, session, classifier, model } = await running({
        agent: new MyAgent(),
        voicemailIdleTimeout: 10_000,
      });
      // Python patches only the tools' job context; AgentSession reads it at start
      jobContext.current = job;
      const activity = session._activity!;
      responses(model).get(DEFAULT_VOICEMAIL_INSTRUCTIONS)!.toolCalls = [
        { name: 'end_call', args: {} },
      ];
      await commit(detector, session, classifier, { reply: true });
      classifier.prediction(1, AMDCategory.MACHINE_VM);
      let call = await waitFor(model.calls.get());
      expect(toolIds(call).has('end_call')).toBe(false);
      await eventually(
        () => internals(detector).voicemailMessagePlayed && noPendingSpeech(activity),
      );
      expect(Math.abs(nextDeadline(detector)! - performance.now() - 10_000)).toBeLessThanOrEqual(
        100,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
      expect(job.shutdown).not.toHaveBeenCalled();

      if (!menuArrives) {
        const result = await advancing(detector.execute(), 6_000);
        expect(result.reason).toBe(AMDReason.IDLE_TIMEOUT);
        expect(result.category).toBe(AMDCategory.MACHINE_VM);
        expect(result.voicemailMessagePlayed).toBe(true);
        expect(job.shutdown).not.toHaveBeenCalled();
        return;
      }

      // The rejected tool call can produce an error follow-up before the next menu.
      while (!model.calls.empty) {
        call = await model.calls.get();
        expect(toolIds(call).has('end_call')).toBe(false);
      }

      const instructions = internals(detector)._getInstructions(AMDCategory.MACHINE_IVR);
      responses(model).set(instructions, {
        input: instructions,
        type: 'llm',
        content: '',
        ttft: 0,
        duration: 0,
        toolCalls: [{ name: 'send_dtmf_events', args: { events: ['1'] } }],
      });
      speechStarted(detector);
      speechEnded(detector, 0);
      void activity.onEndOfTurn(endOfTurn('To save your message, press 1.'));
      await classifier.request();
      classifier.prediction(2, AMDCategory.MACHINE_IVR);
      call = await waitFor(model.calls.get());
      expect(toolIds(call)).toEqual(new Set(['send_dtmf_events']));
      const result = await advancing(detector.execute(), 12_000);
      expect(publishDtmf).toHaveBeenCalledExactlyOnceWith(1, '1');
      expect(result.reason).toBe(AMDReason.IDLE_TIMEOUT);
      expect(result.category).toBe(AMDCategory.MACHINE_IVR);
      expect(result.voicemailMessagePlayed).toBe(true);
      expect(job.shutdown).not.toHaveBeenCalled();
    },
  );

  it('human can end call after AMD', async () => {
    const job = {
      shutdown: vi.fn(),
      addShutdownCallback: vi.fn(),
      simulationContext: () => undefined,
    };
    const { detector, session, classifier, model } = await running({ agent: new MyAgent() });
    // Python patches only the tools' job context; AgentSession reads it at start
    jobContext.current = job;
    responses(model).get('hello')!.toolCalls = [{ name: 'end_call', args: {} }];
    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(1, AMDCategory.HUMAN);
    const call = await waitFor(model.calls.get());
    expect(toolIds(call).has('end_call')).toBe(true);
    await eventually(() => job.shutdown.mock.calls.length > 0);
    expect(job.shutdown).toHaveBeenCalledExactlyOnceWith('user_initiated');
  });
});
