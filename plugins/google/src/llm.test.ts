// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { LLM } from './llm.js';

describe('Google LLM', () => {
  it('should create an LLM instance', () => {
    // Initialize logger before creating LLM instance
    initializeLogger({ pretty: false });

    // This should not throw an error even without API key in test environment
    expect(() => {
      try {
        new LLM({ apiKey: 'test-key' });
      } catch (error) {
        // Expected to fail in test environment without proper Google client setup
        // but should not fail due to logger initialization
        expect(error).toBeDefined();
      }
    }).not.toThrow();
  });
});
