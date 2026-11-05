// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Ported from Python `tests/test_amd_fsm.py`. */
import { describe, expect, it } from 'vitest';
import { AMDCategory as Category } from './events.js';
import * as fsm from './fsm.js';

const ALL = Object.values(Category);
const STAGES = ALL.filter((c) => c !== Category.WAIT);

describe('AMD stage FSM', () => {
  it('transition is repeatable and does not mutate input', () => {
    const state = Category.UNCERTAIN;
    const event = Category.MACHINE_VM;
    const first = fsm.transition(state, event);
    expect(fsm.transition(state, event)).toEqual(first);
    expect(state).toBe(Category.UNCERTAIN);
    expect(first.nextState).toBe(Category.MACHINE_VM);
    expect(first.effects).toEqual([]);
  });

  const recommended: Record<Category, Set<Category>> = {
    [Category.UNCERTAIN]: new Set(ALL),
    [Category.MACHINE_SCREENING]: new Set([
      Category.MACHINE_SCREENING,
      Category.HUMAN,
      Category.MACHINE_VM,
      Category.MACHINE_UNAVAILABLE,
      Category.UNCERTAIN,
      Category.WAIT,
    ]),
    [Category.MACHINE_VM]: new Set([
      Category.MACHINE_VM,
      Category.HUMAN,
      Category.MACHINE_IVR,
      Category.MACHINE_UNAVAILABLE,
      Category.UNCERTAIN,
      Category.WAIT,
    ]),
    [Category.MACHINE_IVR]: new Set([
      Category.MACHINE_IVR,
      Category.HUMAN,
      Category.MACHINE_VM,
      Category.MACHINE_UNAVAILABLE,
      Category.UNCERTAIN,
      Category.WAIT,
    ]),
    [Category.HUMAN]: new Set(),
    [Category.MACHINE_UNAVAILABLE]: new Set(),
    [Category.WAIT]: new Set(),
  };

  describe.each(STAGES)('stage %s', (current) => {
    it.each(ALL)('transitions on %s', (category) => {
      if (recommended[current].size === 0) {
        expect(() => fsm.transition(current, category)).toThrow('invalid AMD transition');
        return;
      }
      const result = fsm.transition(current, category);
      if (category === Category.UNCERTAIN || category === Category.WAIT) {
        expect(result.nextState).toBe(current);
      } else {
        expect(result.nextState).toBe(category);
      }
      if (category === Category.HUMAN || category === Category.MACHINE_UNAVAILABLE) {
        expect(result.effects).toEqual([fsm.Effect.COMPLETE]);
      } else if (category === Category.MACHINE_IVR) {
        expect(result.effects).toEqual([fsm.Effect.EXTRACT_MENU]);
      } else {
        expect(result.effects).toEqual([]);
      }
    });
  });

  const corrections: Array<[Category, Category]> = [
    [Category.MACHINE_SCREENING, Category.MACHINE_IVR],
    [Category.MACHINE_VM, Category.MACHINE_SCREENING],
    [Category.MACHINE_IVR, Category.MACHINE_SCREENING],
  ];

  describe.each([Category.UNCERTAIN, Category.WAIT])('bridge %s', (bridge) => {
    it.each(corrections)('keeps the %s stage before correcting to %s', (initial, corrected) => {
      const intermediate = fsm.transition(initial, bridge);
      expect(intermediate.nextState).toBe(initial);
      expect(intermediate.effects).toEqual([]);
      expect(fsm.transition(intermediate.nextState, corrected).nextState).toBe(corrected);
    });
  });

  it('same IVR state extracts each menu', () => {
    const state = Category.MACHINE_IVR;
    const result = fsm.transition(state, Category.MACHINE_IVR);
    expect(result.nextState).toBe(state);
    expect(result.effects).toEqual([fsm.Effect.EXTRACT_MENU]);
  });

  it.each(corrections)(
    'leaving the recommendations from %s to %s corrects the stage',
    (initial, corrected) => {
      expect(fsm.RECOMMENDED.get(initial)!.has(corrected)).toBe(false);
      const result = fsm.transition(initial, corrected);
      expect(result.nextState).toBe(corrected);
      expect(result.effects).toEqual(
        corrected === Category.MACHINE_IVR ? [fsm.Effect.EXTRACT_MENU] : [],
      );
    },
  );

  it.each([Category.HUMAN, Category.MACHINE_UNAVAILABLE])(
    'terminal stage %s cannot reopen detection',
    (stage) => {
      expect(() => fsm.transition(stage, Category.MACHINE_SCREENING)).toThrow(
        'invalid AMD transition',
      );
    },
  );

  it('recommends sorted next categories', () => {
    expect(fsm.recommendedNext(Category.MACHINE_VM)).toEqual([
      'human',
      'machine-ivr',
      'machine-unavailable',
      'machine-vm',
      'uncertain',
      'wait',
    ]);
  });
});
