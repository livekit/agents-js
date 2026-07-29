// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ToolError, type llm, tool } from '@livekit/agents';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

type Entry = {
  description: string;
  body: string;
};

export class KnowledgeBase {
  private readonly entries: Map<string, Entry>;

  constructor() {
    this.entries = KnowledgeBase.loadEntries();
  }

  private static loadEntries(): Map<string, Entry> {
    const entries = new Map<string, Entry>();
    const productsRoot = KnowledgeBase.productsRoot();
    const productsDir = fileURLToPath(productsRoot);

    for (const filename of readdirSync(productsDir).sort()) {
      if (!filename.endsWith('.md')) {
        continue;
      }
      const resource = new URL(filename, productsRoot);
      const text = readFileSync(resource, 'utf8');
      const newline = text.indexOf('\n');
      const description = (newline === -1 ? text : text.slice(0, newline)).trim();
      const body = (newline === -1 ? '' : text.slice(newline + 1)).trim();
      entries.set(basename(filename, '.md'), { description, body });
    }

    return entries;
  }

  private static productsRoot(): URL {
    const local = new URL('./products/', import.meta.url);
    if (existsSync(local)) {
      return local;
    }
    return new URL('../../../src/homepage/knowledge_base/products/', import.meta.url);
  }

  lookupTool(): llm.FunctionTool {
    const names = [...this.entries.keys()].sort();
    const index = [...this.entries]
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
        additionalProperties: false,
      },
      execute: async ({ product }) => {
        const entry = this.entries.get(String(product ?? ''));
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
