// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  Agent,
  AgentSession,
  ChatContext,
  ModelUsageCollector,
  logMetrics,
  tool,
} from './index.js';

describe('index exports', () => {
  it('exports voice, llm, and metrics APIs directly from the package root', () => {
    expect(Agent).toBeDefined();
    expect(AgentSession).toBeDefined();
    expect(ChatContext).toBeDefined();
    expect(tool).toBeDefined();
    expect(ModelUsageCollector).toBeDefined();
    expect(logMetrics).toBeDefined();
  });
});
