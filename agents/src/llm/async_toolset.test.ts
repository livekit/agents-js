// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { AsyncToolset } from './async_toolset.js';
import { type ToolsetContext, tool } from './tool_context.js';

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

  it('invokes the provided setup on activation', async () => {
    const setup = vi.fn(async (_ctx: ToolsetContext) => {});
    const toolset = AsyncToolset.create({ id: 'booking', tools: [lookup], setup });

    const ctx: ToolsetContext = { updateTools: vi.fn() };
    await toolset.setup(ctx);

    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith(ctx);
  });

  it('invokes the provided aclose on teardown and still drains its executor', async () => {
    const aclose = vi.fn(async () => {});
    const toolset = AsyncToolset.create({ id: 'booking', tools: [lookup], aclose });

    const drainSpy = vi.spyOn(toolset._executor, 'drain');
    const executorCloseSpy = vi.spyOn(toolset._executor, 'aclose');

    await toolset.aclose();

    expect(aclose).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(executorCloseSpy).toHaveBeenCalledTimes(1);
  });
});
