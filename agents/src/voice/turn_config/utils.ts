// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AgentSessionOptions } from '../agent_session.js';
import { defaultEndpointingConfig } from './endpointing.js';
import { defaultInterruptionConfig } from './interruption.js';
import { type TurnHandlingConfig, defaultTurnHandlingConfig } from './turn_handling.js';

export function migrateLegacyOptions<UserData>(
  legacyOptions: AgentSessionOptions<UserData>,
): AgentSessionOptions<UserData> {
  const { voiceOptions, turnDetection, ...rest } = legacyOptions;
  const turnHandling: TurnHandlingConfig = {
    turnDetection: turnDetection ?? defaultTurnHandlingConfig.turnDetection,
    interruption: {
      ...defaultInterruptionConfig,
      discardAudioIfUninterruptible:
        voiceOptions?.discardAudioIfUninterruptible ??
        defaultInterruptionConfig.discardAudioIfUninterruptible,
      minDuration: voiceOptions?.minInterruptionDuration ?? defaultInterruptionConfig.minDuration,
      minWords: voiceOptions?.minInterruptionWords ?? defaultInterruptionConfig.minWords,
    },
    endpointing: {
      ...defaultEndpointingConfig,
      minDelay: voiceOptions?.minEndpointingDelay ?? defaultEndpointingConfig.minDelay,
      maxDelay: voiceOptions?.maxEndpointingDelay ?? defaultEndpointingConfig.maxDelay,
    },
    userAwayTimeout: voiceOptions?.userAwayTimeout ?? defaultTurnHandlingConfig.userAwayTimeout,
    preemptiveGeneration:
      voiceOptions?.preemptiveGeneration ?? defaultTurnHandlingConfig.preemptiveGeneration,

    ...rest.turnHandling,
  };

  const newAgentSessionOptions: AgentSessionOptions<UserData> = {
    ...rest,
    turnDetection: turnHandling.turnDetection,
    turnHandling,
  };

  if (voiceOptions?.allowInterruptions === false) {
    turnHandling.interruption.mode = false;
  }

  newAgentSessionOptions.turnHandling = turnHandling;
  if (voiceOptions?.maxToolSteps) {
    newAgentSessionOptions.maxToolSteps = voiceOptions.maxToolSteps;
  }

  newAgentSessionOptions.voiceOptions = {
    maxToolSteps: newAgentSessionOptions.maxToolSteps,
    maxEndpointingDelay: turnHandling.endpointing.maxDelay,
    minEndpointingDelay: turnHandling.endpointing.minDelay,
    minInterruptionDuration: turnHandling.interruption.minDuration,
    minInterruptionWords: turnHandling.interruption.minWords,
    allowInterruptions: turnHandling.interruption.mode !== false,
    discardAudioIfUninterruptible: turnHandling.interruption.discardAudioIfUninterruptible,
    userAwayTimeout: turnHandling.userAwayTimeout,
  };
  return newAgentSessionOptions;
}
