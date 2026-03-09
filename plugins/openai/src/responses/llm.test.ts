// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { llm, llmStrict } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { LLM } from './llm.js';

initializeLogger({ level: 'silent', pretty: false });

describe('OpenAI Responses', async () => {
  await llm(
    new LLM({
      temperature: 0,
      strictToolSchema: false,
      useWebSocket: false,
    }),
    true,
  );
});

describe('OpenAI Responses strict tool schema', async () => {
  await llmStrict(
    new LLM({
      temperature: 0,
      strictToolSchema: true,
      useWebSocket: false,
    }),
  );
});
