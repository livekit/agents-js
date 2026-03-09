// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { llm, llmStrict } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { LLM } from '../responses/llm.js';

initializeLogger({ level: 'silent', pretty: false });

describe('OpenAI Responses WS wrapper', async () => {
  await llm(
    new LLM({
      temperature: 0,
      strictToolSchema: false,
      useWebSocket: true,
    }),
    true,
  );
});

describe('OpenAI Responses WS wrapper strict tool schema', async () => {
  await llmStrict(
    new LLM({
      temperature: 0,
      strictToolSchema: true,
      useWebSocket: true,
    }),
  );
});
