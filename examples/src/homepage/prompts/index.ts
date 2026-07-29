// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cache = new Map<string, string>();

export function prompt(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  const resource = promptResource(name);
  let text: string;
  try {
    text = readFileSync(resource, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`no prompt named ${JSON.stringify(name)}`);
    }
    throw error;
  }
  cache.set(name, text);
  return text;
}

export function promptPath(name: string): string {
  return fileURLToPath(promptResource(name));
}

function promptResource(name: string): URL {
  const local = new URL(`./${name}.md`, import.meta.url);
  if (existsSync(local)) {
    return local;
  }
  return new URL(`../../../src/homepage/prompts/${name}.md`, import.meta.url);
}
