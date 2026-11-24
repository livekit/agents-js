// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * JS-specific AMD contracts: Python's emitter semantics, a synchronous `start()` install,
 * and a scheduler that stops popping speeches while reply authorization is paused.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../../llm/chat_context.js';
import { SpeechHandle } from '../speech_handle.js';
import {
  ClassifierLLM,
  commit,
  commitTurn,
  endOfTurn,
  eventually,
  internals,
  running,
  waitFor,
} from './amd_test_utils.js';
import { AMD } from './detector.js';
import { AMDCategory, AMDLifecycle, type AMDPredictionEvent, AMDReason } from './events.js';

describe('AMD event emission', () => {
  it('a listener error is logged and the other listeners still run', async () => {
    const { detector, session, classifier } = await running();
    const seen: AMDPredictionEvent[] = [];
    detector.on('amd_prediction', () => {
      throw new Error('listener failed');
    });
    detector.on('amd_prediction', (event) => seen.push(event));
    await commit(detector, session, classifier);
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await waitFor(internals(detector)._shouldReply(1, new ChatContext()));

    expect(seen.map((event) => event.category)).toEqual([AMDCategory.MACHINE_SCREENING]);
    expect(detector.lifecycle).toBe(AMDLifecycle.ACTIVE);
  });

  it('a TypeError from a listener still ends the run', async () => {
    const { detector, session, classifier } = await running();
    detector.on('amd_prediction', () => {
      throw new TypeError('listener bug');
    });
    await commit(detector, session, classifier);
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);

    const result = await waitFor(detector.execute());
    expect(result.reason).toBe(AMDReason.INTERNAL_ERROR);
  });

  it('a completion listener error does not stop aclose or session close', async () => {
    const { detector, session } = await running();
    const completed = vi.fn(() => {
      throw new Error('listener failed');
    });
    detector.on('amd_completed', completed);

    await expect(detector.aclose()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
    expect(completed).toHaveBeenCalledOnce();
    expect((await detector.execute()).reason).toBe(AMDReason.CANCELLED);
  });
});

describe('AMD start', () => {
  it('a second concurrent start is rejected', async () => {
    const { session } = await running();
    // the running detector holds the session; a fresh session is needed for a clean race
    await session.close();
    const { session: fresh } = await running();
    const active = fresh.amd!;
    await active.aclose();

    const first = new AMD(fresh, { llm: new ClassifierLLM(), stt: null });
    const second = new AMD(fresh, { llm: new ClassifierLLM(), stt: null });
    const results = await Promise.allSettled([first.start(), second.start()]);
    try {
      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(String(rejected?.reason)).toContain('amd is already active');
    } finally {
      await first.aclose();
      await second.aclose();
    }
  });
});

describe('AMD idle tracking', () => {
  it('a cancelled queued speech does not keep the agent busy while replies are held', async () => {
    const { detector, session, classifier } = await running({ idleTimeout: 50 });
    const activity = session._activity!;
    await commit(detector, session, classifier);
    classifier.prediction(1, AMDCategory.MACHINE_SCREENING);
    await waitFor(internals(detector)._shouldReply(1, new ChatContext()));

    // a held reply that the next commit cancels stays in the paused queue
    activity.pauseReplyAuthorization();
    const held = SpeechHandle.create();
    (
      activity as unknown as { scheduleSpeech(handle: SpeechHandle, priority: number): void }
    ).scheduleSpeech(held, SpeechHandle.SPEECH_PRIORITY_NORMAL);
    held._cancel();
    // its reply task unwinds and marks it done; the paused scheduler never pops it
    held._markDone();
    expect(held.done()).toBe(true);
    expect(activity._isAgentBusy).toBe(false);

    commitTurn(detector, endOfTurn(''));
    await eventually(() => detector.lifecycle === AMDLifecycle.FINISHED, 1_000);
    expect((await detector.execute()).reason).toBe(AMDReason.IDLE_TIMEOUT);
  });
});
