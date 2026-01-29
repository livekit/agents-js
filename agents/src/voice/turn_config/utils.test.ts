// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { AgentSessionOptions } from '../agent_session.js';
import { defaultEndpointingConfig } from './endpointing.js';
import { defaultInterruptionConfig } from './interruption.js';
import { defaultTurnHandlingConfig } from './turnHandling.js';
import { migrateLegacyOptions } from './utils.js';

describe('migrateLegacyOptions', () => {
  it('should return default turn handling config when no legacy options provided', () => {
    const input: AgentSessionOptions = {};
    const result = migrateLegacyOptions(input);

    expect(result.turnHandling).toBeDefined();
    expect(result.turnHandling!.turnDetection).toBe(defaultTurnHandlingConfig.turnDetection);
    expect(result.turnHandling!.userAwayTimeout).toBe(defaultTurnHandlingConfig.userAwayTimeout);
    expect(result.turnHandling!.preemptiveGeneration).toBe(
      defaultTurnHandlingConfig.preemptiveGeneration,
    );
    expect(result.turnHandling!.interruption).toMatchObject(defaultInterruptionConfig);
    expect(result.turnHandling!.endpointing).toMatchObject(defaultEndpointingConfig);
  });

  it('should migrate legacy turnDetection to turnHandling.turnDetection', () => {
    const input: AgentSessionOptions = {
      turnDetection: 'vad',
    };
    const result = migrateLegacyOptions(input);

    expect(result.turnHandling!.turnDetection).toBe('vad');
    expect('turnDetection' in result).toBe(false);
  });

  it('should set interruption.mode to false when allowInterruptions is false', () => {
    const input: AgentSessionOptions = {
      voiceOptions: {
        allowInterruptions: false,
      },
    };
    const result = migrateLegacyOptions(input);

    expect(result.turnHandling!.interruption!.mode).toBe(false);
    expect('voiceOptions' in result).toBe(false);
  });

  it('should not set interruption.mode when allowInterruptions is true', () => {
    const input: AgentSessionOptions = {
      voiceOptions: {
        allowInterruptions: true,
      },
    };
    const result = migrateLegacyOptions(input);

    // mode should remain undefined (the default) when allowInterruptions is true
    expect(result.turnHandling!.interruption!.mode).toBe(defaultInterruptionConfig.mode);
  });

  it('should migrate voiceOptions interruption settings', () => {
    const input: AgentSessionOptions = {
      voiceOptions: {
        minInterruptionDuration: 0.8,
        minInterruptionWords: 3,
        discardAudioIfUninterruptible: false,
      },
    };
    const result = migrateLegacyOptions(input);

    expect(result.turnHandling!.interruption!.minDuration).toBe(0.8);
    expect(result.turnHandling!.interruption!.minWords).toBe(3);
    expect(result.turnHandling!.interruption!.discardAudioIfUninterruptible).toBe(false);
  });

  it('should migrate voiceOptions endpointing settings', () => {
    const input: AgentSessionOptions = {
      voiceOptions: {
        minEndpointingDelay: 1.0,
        maxEndpointingDelay: 5.0,
      },
    };
    const result = migrateLegacyOptions(input);

    expect(result.turnHandling!.endpointing!.minDelay).toBe(1.0);
    expect(result.turnHandling!.endpointing!.maxDelay).toBe(5.0);
  });

  it('should migrate voiceOptions.preemptiveGeneration', () => {
    const input: AgentSessionOptions = {
      voiceOptions: {
        preemptiveGeneration: true,
      },
    };
    const result = migrateLegacyOptions(input);

    expect(result.turnHandling!.preemptiveGeneration).toBe(true);
  });

  it('should migrate voiceOptions.userAwayTimeout', () => {
    const input: AgentSessionOptions = {
      voiceOptions: {
        userAwayTimeout: 30.0,
      },
    };
    const result = migrateLegacyOptions(input);

    expect(result.turnHandling!.userAwayTimeout).toBe(30.0);
  });

  it('should migrate all legacy options together', () => {
    const input: AgentSessionOptions = {
      turnDetection: 'stt',
      voiceOptions: {
        allowInterruptions: false,
        discardAudioIfUninterruptible: false,
        minInterruptionDuration: 1.0,
        minInterruptionWords: 2,
        minEndpointingDelay: 0.8,
        maxEndpointingDelay: 4.0,
        preemptiveGeneration: true,
        userAwayTimeout: 20.0,
      },
    };
    const result = migrateLegacyOptions(input);

    expect(result.turnHandling!.turnDetection).toBe('stt');
    expect(result.turnHandling!.interruption!.mode).toBe(false);
    expect(result.turnHandling!.interruption!.discardAudioIfUninterruptible).toBe(false);
    expect(result.turnHandling!.interruption!.minDuration).toBe(1.0);
    expect(result.turnHandling!.interruption!.minWords).toBe(2);
    expect(result.turnHandling!.endpointing!.minDelay).toBe(0.8);
    expect(result.turnHandling!.endpointing!.maxDelay).toBe(4.0);
    expect(result.turnHandling!.preemptiveGeneration).toBe(true);
    expect(result.turnHandling!.userAwayTimeout).toBe(20.0);

    // Legacy options should be stripped
    expect('turnDetection' in result).toBe(false);
    expect('voiceOptions' in result).toBe(false);
  });

  it('should preserve non-legacy options in the result', () => {
    const input: AgentSessionOptions = {
      turnDetection: 'vad',
      voiceOptions: {
        minEndpointingDelay: 1.0,
      },
      maxToolSteps: 5,
      connOptions: {
        maxUnrecoverableErrors: 10,
      },
    };
    const result = migrateLegacyOptions(input);

    // Non-legacy options should be preserved
    expect(result.maxToolSteps).toBe(5);
    expect(result.connOptions).toEqual({ maxUnrecoverableErrors: 10 });

    // Legacy options should be stripped and migrated
    expect('turnDetection' in result).toBe(false);
    expect('voiceOptions' in result).toBe(false);
    expect(result.turnHandling!.turnDetection).toBe('vad');
    expect(result.turnHandling!.endpointing!.minDelay).toBe(1.0);
  });
});
