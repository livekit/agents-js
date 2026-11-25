// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Ported from Python `tests/test_amd_corrections.py`. */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../llm/chat_context.js';
import { ChatContext } from '../../llm/chat_context.js';
import type { AgentActivity } from '../agent_activity.js';
import {
  commit,
  commitTurn,
  confirmHuman,
  dtmfCalls,
  dtmfExecuted,
  endOfTurn,
  eventually,
  internals,
  running,
  waitFor,
} from './amd_test_utils.js';
import { DEFAULT_IVR_INSTRUCTIONS, DEFAULT_SCREENING_INSTRUCTIONS } from './detector.js';
import { AMDCategory, AMDReason } from './events.js';
import { LIKELY_HUMAN_STAGES } from './fsm.js';

function noPendingSpeech(activity: AgentActivity): boolean {
  const queue = (activity as unknown as { speechQueue: { size(): number } }).speechQueue;
  const current = activity.currentSpeech;
  return queue.size() === 0 && (current === undefined || current.done());
}

function lastText(chatCtx: ChatContext): string | undefined {
  return (chatCtx.items[chatCtx.items.length - 1] as ChatMessage).textContent;
}

describe('AMD stage corrections', () => {
  describe.each([undefined, AMDCategory.WAIT, AMDCategory.UNCERTAIN])('bridge %s', (bridge) => {
    it.each([
      [
        AMDCategory.MACHINE_VM,
        AMDCategory.MACHINE_SCREENING,
        'Please state your name and why you are calling.',
        DEFAULT_SCREENING_INSTRUCTIONS,
      ],
      [
        AMDCategory.MACHINE_IVR,
        AMDCategory.MACHINE_SCREENING,
        'Please state your name and why you are calling.',
        DEFAULT_SCREENING_INSTRUCTIONS,
      ],
      [
        AMDCategory.MACHINE_SCREENING,
        AMDCategory.MACHINE_IVR,
        'Press 1 for appointments.',
        DEFAULT_IVR_INSTRUCTIONS,
      ],
    ])(
      'correction uses current turn and persists (%s -> %s)',
      async (initial, corrected, transcript, instructions) => {
        const { detector, classifier } = await running();
        const amd = internals(detector);
        const first = commitTurn(detector, endOfTurn('Please record your name.'));
        let request = await classifier.request();
        expect(request.previous_prediction).toBeNull();
        expect(new Set(request.recommended_next_categories)).toEqual(
          new Set(Object.values(AMDCategory)),
        );
        classifier.prediction(1, initial);
        expect(await first.shouldReply(new ChatContext())).toBe(true);
        const savedPrediction = structuredClone(amd.turns.get(1)!.prediction!);
        let previousTurn = 1;
        if (bridge !== undefined) {
          const hooks = commitTurn(detector, endOfTurn('One moment.'));
          await classifier.request();
          classifier.prediction(2, bridge);
          expect(await hooks.shouldReply(new ChatContext())).toBe(bridge !== AMDCategory.WAIT);
          previousTurn = 2;
        }

        const currentTurn = previousTurn + 1;
        const hooks = commitTurn(detector, endOfTurn(transcript));
        request = await classifier.request();
        expect(request.stage).toBe(initial);
        expect(request.previous_prediction).toEqual({
          turn_id: previousTurn,
          category: bridge ?? initial,
          reason: 'prediction',
        });
        expect(request.recommended_next_categories).not.toContain(corrected);
        classifier.prediction(currentTurn, corrected);
        const context = new ChatContext();
        expect(await hooks.shouldReply(context)).toBe(true);
        expect(lastText(context)).toBe(instructions);
        const prediction = amd.turns.get(currentTurn)!.prediction!;
        expect(prediction.reason).toBe(AMDReason.PREDICTION);
        expect(prediction.stage).toBe(corrected);
        expect(amd.previousStage).toBe(initial);
        expect(prediction.inferenceDuration).not.toBeNull();
        expect(amd.turns.get(1)!.prediction).toEqual(savedPrediction);

        const human = commitTurn(detector, endOfTurn('Hello, Sam speaking.'));
        request = await classifier.request();
        expect(request.stage).toBe(corrected);
        expect(request.previous_prediction!.category).toBe(corrected);
        expect(request.previous_prediction!.turn_id).toBe(currentTurn);
        expect(request.recommended_next_categories).toContain(AMDCategory.HUMAN);
        classifier.prediction(currentTurn + 1, AMDCategory.HUMAN);
        expect(await human.shouldReply(new ChatContext())).toBe(true);
        if (LIKELY_HUMAN_STAGES.has(corrected)) {
          expect(amd.turns.get(currentTurn + 1)!.prediction!.category).toBe(AMDCategory.UNCERTAIN);
          const confirmed = await confirmHuman(detector, classifier);
          expect(await confirmed.shouldReply(new ChatContext())).toBe(true);
        }
        expect((await detector.execute()).category).toBe(AMDCategory.HUMAN);
      },
    );
  });

  it('reused turns keep the corrected stage', async () => {
    const { detector, session, classifier } = await running();
    const amd = internals(detector);
    const first = (await commit(detector, session, classifier))!;
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    expect(await first.shouldReply(new ChatContext())).toBe(true);
    const correction = (await commit(detector, session, classifier))!;
    let empty = commitTurn(detector, endOfTurn(''));
    classifier.prediction(2, AMDCategory.MACHINE_SCREENING);
    expect(await correction.shouldReply(new ChatContext())).toBe(false);
    expect(await empty.shouldReply(new ChatContext())).toBe(true);
    expect(amd.turns.get(2)!.prediction!.stage).toBe(AMDCategory.MACHINE_SCREENING);
    empty = commitTurn(detector, endOfTurn(''));
    expect(await empty.shouldReply(new ChatContext())).toBe(true);
    for (const turnId of [3, 4]) {
      const prediction = amd.turns.get(turnId)!.prediction!;
      expect(prediction.reason).toBe(AMDReason.REUSED);
      expect(prediction.stage).toBe(AMDCategory.MACHINE_SCREENING);
    }
    expect(classifier.requests.empty).toBe(true);
  });

  it('correction preserves delivered voicemail and DTMF history', async () => {
    const { detector, session, classifier, model } = await running();
    const amd = internals(detector);
    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(1, AMDCategory.MACHINE_VM);
    await model.calls.get();
    await eventually(() => amd.voicemailMessagePlayed);
    dtmfExecuted(session, '1');

    const activity = session._activity!;
    const transcript = 'Please state your name and why you are calling.';
    expect(await activity.onEndOfTurn(endOfTurn(transcript))).toBe(true);
    const request = await classifier.request();
    expect(dtmfCalls(request.chatCtx).map((call) => JSON.parse(call.args))).toEqual([
      { events: ['1'] },
    ]);
    classifier.prediction(2, AMDCategory.MACHINE_SCREENING);
    const call = await model.calls.get();
    expect(lastText(call.chatCtx)).toBe(DEFAULT_SCREENING_INSTRUCTIONS);
    await eventually(() => noPendingSpeech(activity));

    await commit(detector, session, classifier, { reply: true });
    classifier.prediction(3, AMDCategory.MACHINE_VM);
    await waitFor(activity._userTurnCompletedTask!.result);
    expect(amd.voicemailMessagePlayed).toBe(true);
    expect(model.calls.empty).toBe(true);
    expect(amd.turns.get(3)!.prediction!.stage).toBe(AMDCategory.MACHINE_VM);
  });
});
