// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../../log.js';
import { defaultEndpointingConfig } from './endpointing.js';
import { defaultInterruptionConfig } from './interruption.js';
import { defaultTurnHandlingConfig } from './turn_handling.js';
import { migrateLegacyOptions } from './utils.js';

beforeAll(() => {
  initializeLogger({ pretty: true, level: 'info' });
});

describe('migrateLegacyOptions', () => {
  it('should return all defaults when no options are provided', () => {
    const result = migrateLegacyOptions({});

    expect(result.options.turnHandling).toEqual({
      turnDetection: defaultTurnHandlingConfig.turnDetection,
      endpointing: defaultEndpointingConfig,
      interruption: defaultInterruptionConfig,
    });
    expect(result.options.maxToolSteps).toBe(3);
    expect(result.options.preemptiveGeneration).toBe(false);
    expect(result.options.userAwayTimeout).toBe(15.0);
  });

  it('should migrate legacy flat fields into nested turnHandling config', () => {
    const result = migrateLegacyOptions({
      voiceOptions: {
        minInterruptionDuration: 1.0,
        minInterruptionWords: 3,
        discardAudioIfUninterruptible: false,
        minEndpointingDelay: 0.8,
        maxEndpointingDelay: 5.0,
      },
    });

    expect(result.options.turnHandling.interruption!.minDuration).toBe(1.0);
    expect(result.options.turnHandling.interruption!.minWords).toBe(3);
    expect(result.options.turnHandling.interruption!.discardAudioIfUninterruptible).toBe(false);
    expect(result.options.turnHandling.endpointing!.minDelay).toBe(0.8);
    expect(result.options.turnHandling.endpointing!.maxDelay).toBe(5.0);
  });

  it('should set interruption.mode to false when allowInterruptions is false', () => {
    const result = migrateLegacyOptions({
      options: {
        allowInterruptions: false,
      },
    });

    expect(result.options.turnHandling.interruption!.mode).toBe(false);
  });

  it('should give options precedence over voiceOptions when both are provided', () => {
    const result = migrateLegacyOptions({
      voiceOptions: {
        minInterruptionDuration: 1.0,
        maxEndpointingDelay: 5.0,
        maxToolSteps: 10,
      },
      options: {
        minInterruptionDuration: 2.0,
        maxEndpointingDelay: 8.0,
        maxToolSteps: 5,
      },
    });

    expect(result.options.turnHandling.interruption!.minDuration).toBe(2.0);
    expect(result.options.turnHandling.endpointing!.maxDelay).toBe(8.0);
    expect(result.options.maxToolSteps).toBe(5);
  });

  it('should let explicit turnHandling override legacy flat fields', () => {
    const result = migrateLegacyOptions({
      options: {
        minInterruptionDuration: 1.0,
        minEndpointingDelay: 0.8,
        turnHandling: {
          interruption: { minDuration: 3.0 },
          endpointing: { minDelay: 2.0 },
        },
      },
    });

    expect(result.options.turnHandling.interruption!.minDuration).toBe(3.0);
    expect(result.options.turnHandling.endpointing!.minDelay).toBe(2.0);
  });

  it('should preserve top-level turnDetection in the result', () => {
    const result = migrateLegacyOptions({
      turnDetection: 'vad',
    });

    expect(result.turnDetection).toBe('vad');
    expect(result.options.turnHandling.turnDetection).toBe('vad');
  });
});
