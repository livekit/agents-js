// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export enum AMDLifecycle {
  INITIALIZED = 'initialized',
  PENDING = 'pending',
  ACTIVE = 'active',
  FINISHED = 'finished',
}

export enum AMDCategory {
  HUMAN = 'human',
  MACHINE_IVR = 'machine-ivr',
  MACHINE_SCREENING = 'machine-screening',
  MACHINE_VM = 'machine-vm',
  MACHINE_UNAVAILABLE = 'machine-unavailable',
  /** State remains, reply skipped. */
  WAIT = 'wait',
  /** State remains, reply allowed. */
  UNCERTAIN = 'uncertain',
}

/** Why a prediction was published or why the run completed. */
export enum AMDReason {
  /** A model prediction was released normally. */
  PREDICTION = 'prediction',
  /** An empty turn reused the latest prediction without a new request. */
  REUSED = 'reused',
  /**
   * The turn's inference deadline passed, so the prediction is uncertain in the current stage.
   *
   * Repeated inference timeouts can also complete the run.
   */
  INFERENCE_TIMEOUT = 'inference_timeout',
  /**
   * Classification failed or returned unusable output; the prediction is uncertain in the
   * current stage.
   */
  INFERENCE_ERROR = 'inference_error',
  /** An internal task or prediction handler failed, ending the run. */
  INTERNAL_ERROR = 'internal_error',
  /** AMD reached a human or machine-unavailable category. */
  FINISHED = 'finished',
  /** The limit of consecutive uncertain predictions was reached. */
  MAX_UNCERTAIN_TURNS = 'max_uncertain_turns',
  /** The time limit since listening started was reached. */
  TIMEOUT = 'timeout',
  /** The call stayed silent and inactive for the current stage's idle interval. */
  IDLE_TIMEOUT = 'idle_timeout',
  /** The caller closed AMD or its session before detection completed. */
  CANCELLED = 'cancelled',
  /** The target participant or audio track was unavailable during listening setup. */
  PARTICIPANT_MISSING = 'participant_missing',
  /** The target participant disconnected before detection completed. */
  PARTICIPANT_DISCONNECTED = 'participant_disconnected',
  /** The session switched agents during AMD. */
  AGENT_CHANGED = 'agent_changed',
}

export interface AMDPredictionEvent {
  type: 'amd_prediction';
  /** User speech in this turn, in milliseconds. */
  speechDuration: number;
  /** Prediction for this turn. `uncertain` and `wait` keep the current stage. */
  category: AMDCategory;
  reason: AMDReason;
  transcript: string;
  /** Time from the turn commit to this event, in milliseconds. */
  delay: number;
  turnId: number;
  /** Stage after this prediction. Never `wait`. */
  stage: AMDCategory;
  /** Classification time in milliseconds, or `null` when no model prediction was released. */
  inferenceDuration: number | null;
}

export const createAMDPredictionEvent = ({
  speechDuration,
  category,
  reason,
  transcript,
  delay,
  turnId = 0,
  stage = AMDCategory.UNCERTAIN,
  inferenceDuration = null,
}: {
  speechDuration: number;
  category: AMDCategory;
  reason: AMDReason;
  transcript: string;
  delay: number;
  turnId?: number;
  stage?: AMDCategory;
  inferenceDuration?: number | null;
}): AMDPredictionEvent => ({
  type: 'amd_prediction',
  speechDuration,
  category,
  reason,
  transcript,
  delay,
  turnId,
  stage,
  inferenceDuration,
});

const MACHINE_CATEGORIES: ReadonlySet<AMDCategory> = new Set([
  AMDCategory.MACHINE_SCREENING,
  AMDCategory.MACHINE_IVR,
  AMDCategory.MACHINE_VM,
  AMDCategory.MACHINE_UNAVAILABLE,
]);

/** Whether the prediction is a live person. */
export function isHumanPrediction(event: Pick<AMDPredictionEvent, 'category'>): boolean {
  return event.category === AMDCategory.HUMAN;
}

/** Whether the prediction is any machine category. */
export function isMachinePrediction(event: Pick<AMDPredictionEvent, 'category'>): boolean {
  return MACHINE_CATEGORIES.has(event.category);
}

export interface AMDCompletedEvent {
  type: 'amd_completed';
  /**
   * The call's category. Once the voicemail message has played, a goodbye that
   * ends the box does not make it `machine-unavailable`: the category is the stage
   * before it, `machine-vm`, or `machine-ivr` after a post-message menu.
   */
  category: AMDCategory;
  reason: AMDReason;
  voicemailMessagePlayed: boolean;
  /** The last classified turn's prediction; `null` when the run ended before one. */
  lastPrediction: AMDPredictionEvent | null;
}

export const createAMDCompletedEvent = ({
  category,
  reason,
  voicemailMessagePlayed = false,
  lastPrediction = null,
}: {
  category: AMDCategory;
  reason: AMDReason;
  voicemailMessagePlayed?: boolean;
  lastPrediction?: AMDPredictionEvent | null;
}): AMDCompletedEvent => ({
  type: 'amd_completed',
  category,
  reason,
  voicemailMessagePlayed,
  lastPrediction,
});

export interface IVRMenuOption {
  label: string;
  dtmf: string;
  spokenResponse: string;
}

/** Best-effort observation. This event never authorizes an action. */
export interface AMDMenuObservedEvent {
  type: 'amd_menu_observed';
  sessionId: string;
  turnId: number;
  menu: string;
  options: IVRMenuOption[];
  /** Menu extraction time in milliseconds. */
  extractionDuration: number;
}

export type AMDCallbacks = {
  amd_prediction: (event: AMDPredictionEvent) => void;
  amd_completed: (event: AMDCompletedEvent) => void;
  amd_menu_observed: (event: AMDMenuObservedEvent) => void;
};
