// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { LLM } from './llm.js';

describe('Google LLM', () => {
  it('should create an LLM instance with API key', () => {
    // Initialize logger before creating LLM instance
    initializeLogger({ pretty: false });

    // This should create an LLM instance successfully with API key
    expect(() => {
      const llm = new LLM({
        model: 'gemini-1.5-flash',
        apiKey: 'test-key',
      });
      expect(llm.model).toBe('gemini-1.5-flash');
    }).not.toThrow();
  });

  it('should create an LLM instance with full options', () => {
    initializeLogger({ pretty: false });

    expect(() => {
      const llm = new LLM({
        model: 'gemini-2.0-flash-001',
        apiKey: 'test-key',
        temperature: 0.7,
        maxOutputTokens: 1000,
        topP: 0.9,
        topK: 40,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        toolChoice: 'auto',
        thinkingConfig: { budget: 1000 },
        automaticFunctionCallingConfig: true,
        seed: 42,
      });
      expect(llm.model).toBe('gemini-2.0-flash-001');
    }).not.toThrow();
  });

  it('should validate thinking config budget', () => {
    initializeLogger({ pretty: false });

    expect(() => {
      new LLM({
        apiKey: 'test-key',
        thinkingConfig: { budget: 25000 }, // Over limit
      });
    }).toThrow('thinking_budget inside thinkingConfig must be between 0 and 24576');
  });

  it('should require API key for Google AI Studio', () => {
    initializeLogger({ pretty: false });

    expect(() => {
      new LLM({
        model: 'gemini-1.5-flash',
        // No API key provided
      });
    }).toThrow('API key is required for Google AI Studio');
  });
});
