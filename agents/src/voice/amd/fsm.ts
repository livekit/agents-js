// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Call-category transitions. AMD executes effects and owns the run's lifecycle.
 *
 * `uncertain` and `wait` are per-turn predictions, not stages. They keep the
 * current stage. `RECOMMENDED` lists the usual next predictions for each stage. It guides
 * the classifier but does not restrict it: another category corrects an earlier stage.
 */
import { AMDCategory } from './events.js';

// wait does not change the state
export const RECOMMENDED: ReadonlyMap<AMDCategory, ReadonlySet<AMDCategory>> = new Map([
  [AMDCategory.UNCERTAIN, new Set(Object.values(AMDCategory))],
  [
    AMDCategory.MACHINE_SCREENING,
    new Set([
      AMDCategory.MACHINE_SCREENING,
      AMDCategory.HUMAN,
      AMDCategory.MACHINE_VM,
      AMDCategory.MACHINE_UNAVAILABLE,
      AMDCategory.UNCERTAIN,
      AMDCategory.WAIT,
    ]),
  ],
  [
    AMDCategory.MACHINE_VM,
    new Set([
      AMDCategory.MACHINE_VM,
      AMDCategory.HUMAN,
      AMDCategory.MACHINE_IVR,
      AMDCategory.MACHINE_UNAVAILABLE,
      AMDCategory.UNCERTAIN,
      AMDCategory.WAIT,
    ]),
  ],
  [
    AMDCategory.MACHINE_IVR,
    new Set([
      AMDCategory.MACHINE_IVR,
      AMDCategory.HUMAN,
      AMDCategory.MACHINE_VM,
      AMDCategory.MACHINE_UNAVAILABLE,
      AMDCategory.UNCERTAIN,
      AMDCategory.WAIT,
    ]),
  ],
  [AMDCategory.HUMAN, new Set()],
  [AMDCategory.MACHINE_UNAVAILABLE, new Set()],
]);

// After a menu or a screener, the next speaker can be a person or a voicemail greeting,
// and a short greeting fits both. In these stages a first human prediction is likely
// human: it counts as uncertain, and the next turn decides.
export const LIKELY_HUMAN_STAGES: ReadonlySet<AMDCategory> = new Set([
  AMDCategory.MACHINE_SCREENING,
  AMDCategory.MACHINE_IVR,
]);

export enum Effect {
  EXTRACT_MENU = 'extract_menu',
  COMPLETE = 'complete',
}

export interface Transition {
  readonly nextState: AMDCategory;
  readonly effects: readonly Effect[];
}

/** The recommended next predictions for a stage, sorted like Python's `sorted(...)`. */
export function recommendedNext(state: AMDCategory): AMDCategory[] {
  return [...(RECOMMENDED.get(state) ?? [])].sort();
}

export function transition(state: AMDCategory, prediction: AMDCategory): Transition {
  const recommended = RECOMMENDED.get(state);
  // terminal stages complete AMD, so nothing follows them
  if (recommended === undefined || recommended.size === 0) {
    throw new Error(`invalid AMD transition: ${state} -> ${prediction}`);
  }
  switch (prediction) {
    case AMDCategory.HUMAN:
    case AMDCategory.MACHINE_UNAVAILABLE:
      return { nextState: prediction, effects: [Effect.COMPLETE] };
    case AMDCategory.MACHINE_IVR:
      return { nextState: prediction, effects: [Effect.EXTRACT_MENU] };
    case AMDCategory.UNCERTAIN:
    case AMDCategory.WAIT:
      return { nextState: state, effects: [] };
    default:
      return { nextState: prediction, effects: [] };
  }
}
