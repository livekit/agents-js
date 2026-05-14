// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { Agent } from '../agent.js';
import { mockTools, mockToolsStorage } from './run_result.js';

class AgentA extends Agent {
  constructor() {
    super({ instructions: 'a' });
  }
}

class AgentB extends Agent {
  constructor() {
    super({ instructions: 'b' });
  }
}

describe('mockTools', () => {
  it('sets the mock registry for the given agent inside the callback', async () => {
    const mock = () => 'mocked';

    await mockTools(AgentA, { tool1: mock }, async () => {
      const store = mockToolsStorage.getStore();
      expect(store).toBeDefined();
      expect(store?.get(AgentA)?.tool1).toBe(mock);
    });

    expect(mockToolsStorage.getStore()).toBeUndefined();
  });

  it('merges mocks across nested calls and isolates per agent', async () => {
    const mockA = () => 'a';
    const mockB = () => 'b';

    await mockTools(AgentA, { toolA: mockA }, async () => {
      await mockTools(AgentB, { toolB: mockB }, async () => {
        const store = mockToolsStorage.getStore();
        expect(store?.get(AgentA)?.toolA).toBe(mockA);
        expect(store?.get(AgentB)?.toolB).toBe(mockB);
      });

      const store = mockToolsStorage.getStore();
      expect(store?.get(AgentA)?.toolA).toBe(mockA);
      expect(store?.get(AgentB)).toBeUndefined();
    });
  });

  it('inner call for same agent overrides outer mocks', async () => {
    const outer = () => 'outer';
    const inner = () => 'inner';

    await mockTools(AgentA, { tool1: outer }, async () => {
      await mockTools(AgentA, { tool1: inner }, async () => {
        expect(mockToolsStorage.getStore()?.get(AgentA)?.tool1).toBe(inner);
      });
      expect(mockToolsStorage.getStore()?.get(AgentA)?.tool1).toBe(outer);
    });
  });

  it('supports async mock implementations and returns the callback value', async () => {
    const result = await mockTools(AgentA, { tool1: async () => 42 }, async () => {
      const mock = mockToolsStorage.getStore()?.get(AgentA)?.tool1;
      return await mock?.();
    });
    expect(result).toBe(42);
  });
});
