// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../../log.js';
import {
  type AgentSessionOptions,
  type InternalSessionOptions,
  type VoiceOptions,
  defaultAgentSessionOptions,
} from '../agent_session.js';
import { defaultEndpointingOptions } from './endpointing.js';
import { defaultInterruptionOptions } from './interruption.js';
import { type TurnHandlingOptions, defaultTurnHandlingOptions } from './turn_handling.js';

const defaultLegacyVoiceOptions: VoiceOptions = {
  minEndpointingDelay: defaultTurnHandlingOptions.endpointing.minDelay,
  maxEndpointingDelay: defaultTurnHandlingOptions.endpointing.maxDelay,
  maxToolSteps: defaultAgentSessionOptions.maxToolSteps,
  preemptiveGeneration: defaultAgentSessionOptions.preemptiveGeneration,
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

    turnDetection: sessionOptions?.turnHandling?.turnDetection ?? turnDetection,
  } as const;

  if (voiceOptions?.allowInterruptions === false) {
    turnHandling.interruption.enabled = false;
  }

  const migratedVoiceOptions: AgentSessionOptions<UserData> = {};

  if (voiceOptions?.maxToolSteps !== undefined) {
    migratedVoiceOptions.maxToolSteps = voiceOptions.maxToolSteps;
  }
  if (voiceOptions?.preemptiveGeneration !== undefined) {
    migratedVoiceOptions.preemptiveGeneration = voiceOptions.preemptiveGeneration;
  }
  if (voiceOptions?.userAwayTimeout !== undefined) {
    migratedVoiceOptions.userAwayTimeout = voiceOptions.userAwayTimeout;
  }

  const legacyVoiceOptions = { ...defaultLegacyVoiceOptions, ...voiceOptions };

  const agentSessionOptions = {
    stt,
    vad,
    llm,
    tts,
    userData,
    connOptions,
    ...defaultAgentSessionOptions,
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
    endpointing: { ...defaultEndpointingOptions, ...stripUndefined(config.endpointing) },
    interruption: { ...defaultInterruptionOptions, ...stripUndefined(config.interruption) },
  } as const;
}
