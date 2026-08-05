// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';

const cache = new Map<string, string>();

export function prompt(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const value = readFileSync(new URL(`${name}.md`, import.meta.url), 'utf8');
  cache.set(name, value);
  return value;
}
