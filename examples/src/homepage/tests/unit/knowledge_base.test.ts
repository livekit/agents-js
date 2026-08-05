// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { KnowledgeBase } from '../../knowledge_base/index.js';

const EXPECTED_TOPICS = [
  'agent-builder',
  'agent-observability',
  'agents-on-livekit-cloud',
  'livekit-inference',
  'livekit-phone-numbers',
  'platform',
];

describe('knowledge base', () => {
  it('builds the lookup tool index from bundled knowledge', () => {
    const tool = new KnowledgeBase().lookupTool();
    expect(tool.name).toBe('lookup_product');
    const parameters = tool.parameters as {
      properties: { product: { enum: string[] } };
    };
    expect(new Set(parameters.properties.product.enum)).toEqual(new Set(EXPECTED_TOPICS));
    for (const topic of EXPECTED_TOPICS) {
      expect(tool.description).toContain(`- ${topic}: `);
    }
  });
});
