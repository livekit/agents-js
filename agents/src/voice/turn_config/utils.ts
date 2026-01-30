// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../../log.js';
import {
  type AgentSessionOptions,
  type InternalSessionOptions,
  defaultSessionOptions,
} from '../agent_session.js';
import { defaultEndpointingConfig } from './endpointing.js';
import { defaultInterruptionConfig } from './interruption.js';
import { type TurnHandlingConfig, defaultTurnHandlingConfig } from './turn_handling.js';

export function migrateLegacyOptions<UserData>(
  legacyOptions: AgentSessionOptions<UserData>,
): AgentSessionOptions<UserData> & { options: InternalSessionOptions } {
  const logger = log();
  const { voiceOptions, turnDetection, options: sessionOptions, ...rest } = legacyOptions;

  if (voiceOptions !== undefined && sessionOptions !== undefined) {
    logger.warn(
      'Both voiceOptions and options have been supplied as part of the AgentSessionOptions, voiceOptions will be merged with options taking precedence',
    );
  }

  const mergedOptions = structuredClone({ ...voiceOptions, ...sessionOptions });

  const turnHandling: TurnHandlingConfig = {
    turnDetection: turnDetection,
    interruption: {
      discardAudioIfUninterruptible: mergedOptions?.discardAudioIfUninterruptible,
      minDuration: mergedOptions?.minInterruptionDuration,
      minWords: mergedOptions?.minInterruptionWords,
    },
    endpointing: {
      minDelay: mergedOptions?.minEndpointingDelay,
      maxDelay: mergedOptions?.maxEndpointingDelay,
    },

    ...mergedOptions.turnHandling,
  } as const;

  if (mergedOptions?.allowInterruptions === false) {
    turnHandling.interruption.mode = false;
  }

  const optionsWithDefaults = {
    ...defaultSessionOptions,
    ...mergedOptions,
    turnHandling: mergeWithDefaults(turnHandling),
  };

  const newAgentSessionOptions: AgentSessionOptions<UserData> & {
    options: InternalSessionOptions;
  } = {
    ...rest,
    options: optionsWithDefaults,
    voiceOptions: optionsWithDefaults,
    turnDetection: turnHandling.turnDetection,
  };

  return newAgentSessionOptions;
}

/** Remove keys whose value is `undefined` so they don't shadow defaults when spread. */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function mergeWithDefaults(config: TurnHandlingConfig) {
  return {
    turnDetection: config.turnDetection ?? defaultTurnHandlingConfig.turnDetection,
    endpointing: { ...defaultEndpointingConfig, ...stripUndefined(config.endpointing) },
    interruption: { ...defaultInterruptionConfig, ...stripUndefined(config.interruption) },
  } as const;
}
