// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../../log.js';
import { defaultEndpointingOptions } from './endpointing.js';
import { defaultInterruptionOptions } from './interruption.js';
import { defaultTurnHandlingOptions } from './turn_handling.js';
import { migrateLegacyOptions } from './utils.js';

beforeAll(() => {
  initializeLogger({ pretty: true, level: 'info' });
});

describe('migrateLegacyOptions', () => {
  it('should return all defaults when no options are provided', () => {
    const result = migrateLegacyOptions({});

    expect(result.resolvedSessionOptions.turnHandling).toEqual({
      turnDetection: defaultTurnHandlingOptions.turnDetection,
      endpointing: defaultEndpointingOptions,
      interruption: defaultInterruptionOptions,
    });
    expect(result.resolvedSessionOptions.maxToolSteps).toBe(3);
    expect(result.resolvedSessionOptions.preemptiveGeneration).toBe(false);
    expect(result.resolvedSessionOptions.userAwayTimeout).toBe(15.0);
  });

  it('should migrate legacy flat fields into nested turnHandling config', () => {
    const result = migrateLegacyOptions({
      voiceOptions: {
        minInterruptionDuration: 1000,
        minInterruptionWords: 3,
        discardAudioIfUninterruptible: false,
        minEndpointingDelay: 800,
        maxEndpointingDelay: 5000,
      },
    });

    expect(result.resolvedSessionOptions.turnHandling.interruption!.minDuration).toBe(1000);
    expect(result.resolvedSessionOptions.turnHandling.interruption!.minWords).toBe(3);
    expect(result.resolvedSessionOptions.turnHandling.interruption!.discardAudioIfUninterruptible).toBe(false);
    expect(result.resolvedSessionOptions.turnHandling.endpointing!.minDelay).toBe(800);
    expect(result.resolvedSessionOptions.turnHandling.endpointing!.maxDelay).toBe(5000);
  });

  it('should set interruption.enabled to false when allowInterruptions is false', () => {
    const result = migrateLegacyOptions({
      allowInterruptions: false,
    });

    expect(result.resolvedSessionOptions.turnHandling.interruption!.enabled).toBe(false);
  });

  it('should give top-level fields precedence over voiceOptions', () => {
    const result = migrateLegacyOptions({
      voiceOptions: {
        minInterruptionDuration: 1000,
        maxEndpointingDelay: 5000,
        maxToolSteps: 10,
      },
      minInterruptionDuration: 2000,
      maxEndpointingDelay: 8000,
      maxToolSteps: 5,
    });

    expect(result.resolvedSessionOptions.turnHandling.interruption!.minDuration).toBe(2000);
    expect(result.resolvedSessionOptions.turnHandling.endpointing!.maxDelay).toBe(8000);
    expect(result.resolvedSessionOptions.maxToolSteps).toBe(5);
  });

  it('should let explicit turnHandling override legacy flat fields', () => {
    const result = migrateLegacyOptions({
      minInterruptionDuration: 1000,
      minEndpointingDelay: 800,
      turnHandling: {
        interruption: { minDuration: 3000 },
        endpointing: { minDelay: 2000 },
      },
    });

    expect(result.resolvedSessionOptions.turnHandling.interruption!.minDuration).toBe(3000);
    expect(result.resolvedSessionOptions.turnHandling.endpointing!.minDelay).toBe(2000);
  });

  it('should preserve top-level turnDetection in the result', () => {
    const result = migrateLegacyOptions({
      turnDetection: 'vad',
    });

    expect(result.resolvedSessionOptions.turnHandling.turnDetection).toBe('vad');
  });
});
