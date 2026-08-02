// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { finalizeJobShutdown } from './job_proc_shutdown.js';

describe('finalizeJobShutdown', () => {
  it('continues shutdown when room disconnect rejects', async () => {
    const steps: string[] = [];
    const disconnectError = new Error('handle not found');
    const room = {
      disconnect: vi.fn(async () => {
        steps.push('disconnect');
        throw disconnectError;
      }),
    };
    const shutdownCallback = vi.fn(async () => {
      steps.push('callback');
    });
    const onDone = vi.fn(() => {
      steps.push('done');
    });
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;

    await expect(
      finalizeJobShutdown({
        room,
        shutdownCallbacks: [shutdownCallback],
        logger,
        onDone,
      }),
    ).resolves.toBeUndefined();

    expect(steps).toEqual(['disconnect', 'callback', 'done']);
    expect(logger.error).toHaveBeenCalledWith(
      { error: disconnectError },
      'error in room.disconnect',
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
