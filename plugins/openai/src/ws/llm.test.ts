// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, llmStrict } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { LLM } from './llm.js';

describe('OpenAI Responses WS', async () => {
  await llm(
    new LLM({
      temperature: 0,
      strictToolSchema: false,
    }),
    true,
  );
});

describe('OpenAI Responses WS strict tool schema', async () => {
  await llmStrict(
    new LLM({
      temperature: 0,
      strictToolSchema: true,
    }),
  );
});
