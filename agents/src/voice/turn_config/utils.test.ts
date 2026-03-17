// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../../log.js';
import { defaultAgentSessionOptions } from '../agent_session.js';
import { defaultEndpointingOptions } from './endpointing.js';
import { defaultInterruptionOptions } from './interruption.js';
import { defaultTurnHandlingOptions } from './turn_handling.js';
import { migrateLegacyOptions } from './utils.js';

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
    });
    expect(result.maxToolSteps).toBe(defaultAgentSessionOptions.maxToolSteps);
    expect(result.preemptiveGeneration).toBe(defaultAgentSessionOptions.preemptiveGeneration);
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
