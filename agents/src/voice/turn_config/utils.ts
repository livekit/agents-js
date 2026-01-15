import type { AgentSessionOptions } from '../agent_session.js';
import {
  type TurnHandlingConfig,
  defaultEndpointingConfig,
  defaultInterruptionConfig,
  defaultTurnHandlingConfig,
} from './index.js';

export function migrateLegacyOptions(
  legacyOptions: AgentSessionOptions,
): Omit<AgentSessionOptions, 'voiceOptions' | 'turnDetection'> {
  const { voiceOptions, turnDetection, ...rest } = legacyOptions;
  const newAgentSessionOptions = rest;
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
  };

  if (voiceOptions?.allowInterruptions === false) {
    turnHandling.interruption.mode = false;
  }

  newAgentSessionOptions.turnHandling = turnHandling;
  if (voiceOptions?.maxToolSteps) {
    newAgentSessionOptions.maxToolSteps = voiceOptions.maxToolSteps;
  }
  return newAgentSessionOptions;
}
