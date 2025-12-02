// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { LLM } from './llm.js';

describe('Baseten', async () => {
  await llm(
    new LLM({
      model: 'openai/gpt-4o-mini',
      temperature: 0,
    }),
    false,
  );
});
