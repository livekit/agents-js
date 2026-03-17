// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log } from '../../log.js';
import {
  type AgentSessionOptions,
  type InternalSessionOptions,
  defaultSessionOptions,
} from '../agent_session.js';
import { defaultEndpointingOptions } from './endpointing.js';
import { defaultInterruptionOptions } from './interruption.js';
import { type TurnHandlingOptions, defaultTurnHandlingOptions } from './turn_handling.js';

export type MigratedOptions<UserData> = {
  stt?: AgentSessionOptions<UserData>['stt'];
  vad?: AgentSessionOptions<UserData>['vad'];
  llm?: AgentSessionOptions<UserData>['llm'];
  tts?: AgentSessionOptions<UserData>['tts'];
  userData?: UserData;
  connOptions?: AgentSessionOptions<UserData>['connOptions'];
  resolvedSessionOptions: InternalSessionOptions;
};

export function migrateLegacyOptions<UserData>(
  legacyOptions: AgentSessionOptions<UserData>,
): MigratedOptions<UserData> {
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

  // Preserve turnDetection before cloning since structuredClone converts class instances to plain objects
  const originalTurnDetection =
    sessionOptions?.turnHandling?.turnDetection ??
    voiceOptions?.turnHandling?.turnDetection ??
    turnDetection;

  // Exclude potentially non-cloneable turnDetection objects before structuredClone.
  // They are restored from originalTurnDetection below.
  const cloneableVoiceOptions = voiceOptions
    ? {
        ...voiceOptions,
        turnHandling: voiceOptions.turnHandling
          ? { ...voiceOptions.turnHandling, turnDetection: undefined }
          : voiceOptions.turnHandling,
      }
    : voiceOptions;
  const cloneableSessionOptions = sessionOptions
    ? {
        ...sessionOptions,
        turnHandling: sessionOptions.turnHandling
          ? { ...sessionOptions.turnHandling, turnDetection: undefined }
          : sessionOptions.turnHandling,
      }
    : undefined;

  const mergedOptions = structuredClone({ ...cloneableVoiceOptions, ...cloneableSessionOptions });

  const turnHandling: TurnHandlingOptions = {
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
    // Restore original turnDetection after spread to preserve class instance with methods
    // (structuredClone converts class instances to plain objects, losing prototype methods)
    turnDetection: originalTurnDetection,
  } as const;

  if (mergedOptions?.allowInterruptions === false) {
    turnHandling.interruption.enabled = false;
  }

  const resolvedSessionOptions = {
    ...defaultSessionOptions,
    ...mergedOptions,
    turnHandling: mergeWithDefaults(turnHandling),
  };

  return {
    stt,
    vad,
    llm,
    tts,
    userData,
    connOptions,
    resolvedSessionOptions,
  };
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
