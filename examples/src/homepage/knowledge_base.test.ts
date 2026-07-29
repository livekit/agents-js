// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { KnowledgeBase } from './knowledge_base/index.js';

const EXPECTED_TOPICS = new Set([
  'agent-builder',
  'agent-observability',
  'agents-on-livekit-cloud',
  'livekit-inference',
  'livekit-phone-numbers',
  'platform',
]);

describe('homepage knowledge base', () => {
  it('builds the lookup tool index from the knowledge base', () => {
    const schema = KnowledgeBase.prototype.lookupTool.call(new KnowledgeBase());
    const parameters = schema.parameters as {
      properties: { product: { enum: string[] } };
    };

    expect(schema.name).toBe('lookup_product');
    expect(new Set(parameters.properties.product.enum)).toEqual(EXPECTED_TOPICS);
    for (const topic of EXPECTED_TOPICS) {
      expect(schema.description).toContain(`- ${topic}: `);
    }
  });
});
