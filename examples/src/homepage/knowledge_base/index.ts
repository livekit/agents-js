// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type FunctionTool, ToolError, tool } from '@livekit/agents';
import { readFileSync, readdirSync } from 'node:fs';

type Entry = { description: string; body: string };

export class KnowledgeBase {
  readonly #entries = KnowledgeBase.loadEntries();

  static loadEntries(): Map<string, Entry> {
    const products = new URL('./products/', import.meta.url);
    const entries = new Map<string, Entry>();
    for (const file of readdirSync(products).sort()) {
      if (!file.endsWith('.md')) continue;
      const [description = '', ...body] = readFileSync(new URL(file, products), 'utf8').split('\n');
      entries.set(file.slice(0, -3), {
        description: description.trim(),
        body: body.join('\n').trim(),
      });
    }
    return entries;
  }

  lookupTool(): FunctionTool {
    const names = [...this.#entries.keys()].sort();
    const index = [...this.#entries]
      .map(([name, entry]) => `- ${name}: ${entry.description}`)
      .join('\n');

    return tool({
      name: 'lookup_product',
      description:
        'Fetch the full knowledge base for one LiveKit product. Call this ' +
        'before answering any question about a LiveKit product other than ' +
        'the Agents SDKs - look it up rather than answering from memory. ' +
        `Products:\n${index}`,
      parameters: {
        type: 'object',
        properties: {
          product: {
            type: 'string',
            description: 'The product to fetch information about.',
            enum: names,
          },
        },
        required: ['product'],
      },
      execute: async (rawArguments) => {
        const product = String(rawArguments.product ?? '');
        const entry = this.#entries.get(product);
        if (!entry) {
          throw new ToolError(
            `unknown product ${JSON.stringify(product)} - valid products: ${names.join(', ')}`,
          );
        }
        return entry.body;
      },
    });
  }
}
