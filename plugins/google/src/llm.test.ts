// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents-plugins-test';
import { describe } from 'vitest';
import { LLM } from './llm.js';

describe('Google', async () => {
  await llm(
    new LLM({
      model: 'gemini-2.5-flash',
      temperature: 0,
    }),
    true,
  );
});
