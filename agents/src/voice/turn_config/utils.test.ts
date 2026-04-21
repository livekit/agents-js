// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../../log.js';
import { defaultAgentSessionOptions } from '../agent_session.js';
import { defaultEndpointingOptions } from './endpointing.js';
import { defaultInterruptionOptions } from './interruption.js';
import { defaultPreemptiveGenerationOptions } from './preemptive_generation.js';
import { defaultTurnHandlingOptions } from './turn_handling.js';
import { migrateLegacyOptions, migrateTurnHandling } from './utils.js';

beforeAll(() => {
  initializeLogger({ pretty: true, level: 'info' });
});

describe('migrateLegacyOptions', () => {
  it('should return all defaults when no options are provided', () => {
    const { agentSessionOptions: result } = migrateLegacyOptions({});

    expect(result.turnHandling).toEqual({
      turnDetection: defaultTurnHandlingOptions.turnDetection,
      endpointing: defaultEndpointingOptions,
      interruption: defaultInterruptionOptions,
      preemptiveGeneration: defaultPreemptiveGenerationOptions,
    });
    expect(result.maxToolSteps).toBe(defaultAgentSessionOptions.maxToolSteps);
    expect(result.userAwayTimeout).toBe(defaultAgentSessionOptions.userAwayTimeout);
  });

  it('should migrate legacy flat fields into nested turnHandling config', () => {
    const { agentSessionOptions: result } = migrateLegacyOptions({
      voiceOptions: {
        minInterruptionDuration: 1000,
        minInterruptionWords: 3,
        discardAudioIfUninterruptible: false,
        minEndpointingDelay: 800,
        maxEndpointingDelay: 5000,
      },
    });

    expect(result.turnHandling.interruption!.minDuration).toBe(1000);
    expect(result.turnHandling.interruption!.minWords).toBe(3);
    expect(result.turnHandling.interruption!.discardAudioIfUninterruptible).toBe(false);
    expect(result.turnHandling.endpointing!.minDelay).toBe(800);
    expect(result.turnHandling.endpointing!.maxDelay).toBe(5000);
  });

  it('should set interruption.enabled to false when allowInterruptions is false', () => {
    const { agentSessionOptions: result } = migrateLegacyOptions({
      voiceOptions: { allowInterruptions: false },
    });

    expect(result.turnHandling.interruption!.enabled).toBe(false);
  });

  it('should give top-level fields precedence over voiceOptions', () => {
    const { agentSessionOptions: result } = migrateLegacyOptions({
      voiceOptions: {
        minInterruptionDuration: 1000,
        maxEndpointingDelay: 5000,
        maxToolSteps: 10,
      },
      turnHandling: {
        interruption: {
          minDuration: 2000,
        },
        endpointing: {
          maxDelay: 8000,
        },
      },
      maxToolSteps: 5,
    });

    expect(result.turnHandling.interruption!.minDuration).toBe(2000);
    expect(result.turnHandling.endpointing!.maxDelay).toBe(8000);
    expect(result.maxToolSteps).toBe(5);
  });

  it('should preserve top-level turnDetection in the result', () => {
    const { agentSessionOptions: result } = migrateLegacyOptions({
      turnDetection: 'vad',
    });

    expect(result.turnHandling.turnDetection).toBe('vad');
  });

});

describe('migrateTurnHandling', () => {
  it('should return empty partial when no deprecated Agent fields are given', () => {
    const result = migrateTurnHandling({});
    expect(result).toEqual({});
  });

  it('should set interruption.enabled to false when allowInterruptions is false', () => {
    const result = migrateTurnHandling({ allowInterruptions: false });
    expect(result.interruption).toEqual({ enabled: false });
    expect(result.endpointing).toBeUndefined();
    expect(result.turnDetection).toBeUndefined();
  });

  it('should not set interruption when allowInterruptions is true or undefined', () => {
    expect(migrateTurnHandling({ allowInterruptions: true })).toEqual({});
    expect(migrateTurnHandling({ allowInterruptions: undefined })).toEqual({});
  });

  it('should map minEndpointingDelay to endpointing.minDelay', () => {
    const result = migrateTurnHandling({ minEndpointingDelay: 800 });
    expect(result.endpointing).toEqual({ minDelay: 800 });
  });

  it('should map maxEndpointingDelay to endpointing.maxDelay', () => {
    const result = migrateTurnHandling({ maxEndpointingDelay: 5000 });
    expect(result.endpointing).toEqual({ maxDelay: 5000 });
  });

  it('should pass through turnDetection', () => {
    const result = migrateTurnHandling({ turnDetection: 'vad' });
    expect(result.turnDetection).toBe('vad');
  });

  it('should combine all deprecated Agent fields', () => {
    const result = migrateTurnHandling({
      turnDetection: 'stt',
      allowInterruptions: false,
      minEndpointingDelay: 400,
      maxEndpointingDelay: 3000,
    });
    expect(result.turnDetection).toBe('stt');
    expect(result.interruption).toEqual({ enabled: false });
    expect(result.endpointing).toEqual({ minDelay: 400, maxDelay: 3000 });
  });

  it('should map preemptiveGeneration boolean to preemptiveGeneration.enabled', () => {
    const resultTrue = migrateTurnHandling({ preemptiveGeneration: true });
    expect(resultTrue.preemptiveGeneration).toEqual({ enabled: true });

    const resultFalse = migrateTurnHandling({ preemptiveGeneration: false });
    expect(resultFalse.preemptiveGeneration).toEqual({ enabled: false });
  });

  it('should ignore deprecated Agent fields when explicit turnHandling is provided', () => {
    const turnHandling = {
      endpointing: { minDelay: 999, maxDelay: 4000 },
      interruption: { enabled: true },
      turnDetection: 'vad' as const,
    };
    const result = migrateTurnHandling({
      turnHandling,
      turnDetection: 'stt',
      allowInterruptions: false,
      minEndpointingDelay: 100,
      maxEndpointingDelay: 200,
    });
    expect(result).toEqual(turnHandling);
  });
});
