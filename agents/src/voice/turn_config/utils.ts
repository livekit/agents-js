// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../../log.js';
import {
  type AgentSessionOptions,
  type InternalSessionOptions,
  type TurnDetectionMode,
  type VoiceOptions,
} from '../agent_session.js';
import { defaultEndpointingOptions } from './endpointing.js';
import { defaultInterruptionOptions } from './interruption.js';
import { defaultPreemptiveGenerationOptions } from './preemptive_generation.js';
import { type TurnHandlingOptions, defaultTurnHandlingOptions } from './turn_handling.js';

const defaultSessionOptions = {
  maxToolSteps: 3,
  userAwayTimeout: 15.0,
  aecWarmupDuration: 3000,
  turnHandling: {},
  useTtsAlignedTranscript: true,
} as const satisfies AgentSessionOptions;

const defaultLegacyVoiceOptions: VoiceOptions = {
  minEndpointingDelay: defaultTurnHandlingOptions.endpointing.minDelay,
  maxEndpointingDelay: defaultTurnHandlingOptions.endpointing.maxDelay,
  maxToolSteps: defaultSessionOptions.maxToolSteps,
};

export function migrateLegacyOptions<UserData>(legacyOptions: AgentSessionOptions<UserData>): {
  agentSessionOptions: InternalSessionOptions<UserData>;
  legacyVoiceOptions: VoiceOptions;
} {
  const logger = log();
  const {
    voiceOptions,
    turnDetection,
    stt,
    vad,
    llm,
    tts,
    userData,
    connOptions,
    ...sessionOptions
  } = legacyOptions;

  if (voiceOptions !== undefined) {
    logger.warn(
      'voiceOptions is deprecated, use top-level SessionOptions fields on AgentSessionOptions instead',
    );
  }

  const turnHandling: TurnHandlingOptions = {
    interruption: {
      discardAudioIfUninterruptible: voiceOptions?.discardAudioIfUninterruptible,
      minDuration: voiceOptions?.minInterruptionDuration,
      minWords: voiceOptions?.minInterruptionWords,
      ...sessionOptions.turnHandling?.interruption,
    },
    endpointing: {
      minDelay: voiceOptions?.minEndpointingDelay,
      maxDelay: voiceOptions?.maxEndpointingDelay,
      ...sessionOptions.turnHandling?.endpointing,
    },
    preemptiveGeneration: {
      ...sessionOptions.turnHandling?.preemptiveGeneration,
    },

    turnDetection: sessionOptions?.turnHandling?.turnDetection ?? turnDetection,
  } as const;

  if (
    voiceOptions?.allowInterruptions === false &&
    turnHandling.interruption.enabled === undefined
  ) {
    turnHandling.interruption.enabled = false;
  }

  const migratedVoiceOptions: AgentSessionOptions<UserData> = {};

  if (voiceOptions?.maxToolSteps !== undefined) {
    migratedVoiceOptions.maxToolSteps = voiceOptions.maxToolSteps;
  }
  if (voiceOptions?.userAwayTimeout !== undefined) {
    migratedVoiceOptions.userAwayTimeout = voiceOptions.userAwayTimeout;
  }

  // Migrate deprecated top-level preemptiveGeneration boolean into turn_handling
  const deprecatedPreemptiveGen =
    legacyOptions.preemptiveGeneration ?? voiceOptions?.preemptiveGeneration;
  if (deprecatedPreemptiveGen !== undefined) {
    logger.warn(
      'preemptiveGeneration as a top-level option is deprecated, use turnHandling.preemptiveGeneration instead',
    );
    if (turnHandling.preemptiveGeneration.enabled === undefined) {
      turnHandling.preemptiveGeneration = {
        ...turnHandling.preemptiveGeneration,
        enabled: deprecatedPreemptiveGen,
      };
    }
  }

  const legacyVoiceOptions = { ...defaultLegacyVoiceOptions, ...voiceOptions };

  const agentSessionOptions = {
    stt,
    vad,
    llm,
    tts,
    userData,
    connOptions,
    ...defaultSessionOptions,
    ...migratedVoiceOptions,
    ...sessionOptions,
    turnHandling: mergeWithDefaults(turnHandling),
    // repopulate the deprecated voice options with migrated options for backwards compatibility
    voiceOptions: legacyVoiceOptions,
  };

  return { agentSessionOptions, legacyVoiceOptions };
}

/** Remove keys whose value is `undefined` so they don't shadow defaults when spread. */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function mergeWithDefaults(config: TurnHandlingOptions) {
  return {
    turnDetection: config.turnDetection ?? defaultTurnHandlingOptions.turnDetection,
    // Ref: python livekit-agents/livekit/agents/voice/turn.py - 186-190 lines
    endpointing: { ...defaultEndpointingOptions, ...stripUndefined(config.endpointing) },
    interruption: { ...defaultInterruptionOptions, ...stripUndefined(config.interruption) },
    preemptiveGeneration: {
      ...defaultPreemptiveGenerationOptions,
      ...stripUndefined(config.preemptiveGeneration ?? {}),
    },
  } as const;
}

/**
 * Build a partial {@link TurnHandlingOptions} from deprecated Agent constructor fields.
 * Mirrors the Python Agent compatibility path, but keeps the JS API surface explicit.
 */
export function migrateTurnHandling(opts: {
  turnDetection?: TurnDetectionMode;
  allowInterruptions?: boolean;
  preemptiveGeneration?: boolean;
  minEndpointingDelay?: number;
  maxEndpointingDelay?: number;
  turnHandling?: TurnHandlingOptions;
}): Partial<TurnHandlingOptions> {
  if (opts.turnHandling !== undefined) {
    return opts.turnHandling;
  }

  const migrated: Partial<TurnHandlingOptions> = {};

  const endpointing: Partial<TurnHandlingOptions['endpointing']> = {};
  if (opts.minEndpointingDelay !== undefined) {
    endpointing.minDelay = opts.minEndpointingDelay;
  }
  if (opts.maxEndpointingDelay !== undefined) {
    endpointing.maxDelay = opts.maxEndpointingDelay;
  }
  if (Object.keys(endpointing).length > 0) {
    migrated.endpointing = endpointing;
  }

  const interruption: Partial<TurnHandlingOptions['interruption']> = {};
  if (opts.allowInterruptions === false) {
    interruption.enabled = false;
  }
  if (Object.keys(interruption).length > 0) {
    migrated.interruption = interruption;
  }

  if (opts.turnDetection !== undefined) {
    migrated.turnDetection = opts.turnDetection;
  }

  if (opts.preemptiveGeneration !== undefined) {
    migrated.preemptiveGeneration = { enabled: opts.preemptiveGeneration };
  }

  return {
    ...(migrated.endpointing ? { endpointing: migrated.endpointing } : {}),
    ...(migrated.interruption ? { interruption: migrated.interruption } : {}),
    ...(migrated.turnDetection !== undefined ? { turnDetection: migrated.turnDetection } : {}),
    ...(migrated.preemptiveGeneration
      ? { preemptiveGeneration: migrated.preemptiveGeneration }
      : {}),
  };
}
