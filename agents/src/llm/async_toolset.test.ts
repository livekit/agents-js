// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { AsyncToolset } from './async_toolset.js';
import { tool } from './tool_context.js';

describe('AsyncToolset', () => {
  const lookup = tool({
    name: 'lookup',
    description: 'lookup',
    execute: async () => 'ok',
  });

  it('is a scope container, not a separate async tool type', () => {
    const toolset = AsyncToolset.create({ id: 'booking', tools: [lookup] });

    expect(toolset.id).toBe('booking');
    expect(toolset.tools).toEqual([lookup]);
    expect(toolset._executor).toBeDefined();
  });

  it('rejects the legacy onDuplicateCall option', () => {
    expect(() =>
      AsyncToolset.create({
        id: 'booking',
        tools: [lookup],
        // @ts-expect-error - legacy Python option must be rejected at runtime
        onDuplicateCall: 'confirm',
      }),
    ).toThrow(/onDuplicateCall/);
  });
});
