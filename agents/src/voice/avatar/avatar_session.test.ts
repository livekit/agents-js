// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as jobModule from '../../job.js';
import * as logModule from '../../log.js';
import { AvatarSession } from './avatar_session.js';

describe('AvatarSession base', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers aclose with job shutdown callback', async () => {
    let shutdownCallback: (() => Promise<void>) | undefined;
    const addShutdownCallback = vi.fn((cb: () => Promise<void>) => {
      shutdownCallback = cb;
    });
    vi.spyOn(jobModule, 'getJobContext').mockReturnValue({
      addShutdownCallback,
    } as unknown as ReturnType<typeof jobModule.getJobContext>);

    const session = new AvatarSession();
    const acloseSpy = vi.spyOn(session, 'aclose').mockResolvedValue();

    await session.start({ _started: false, output: { audio: null } } as any, {} as any);

    expect(addShutdownCallback).toHaveBeenCalledTimes(1);
    expect(shutdownCallback).toBeTypeOf('function');

    await shutdownCallback?.();
    expect(acloseSpy).toHaveBeenCalledTimes(1);
  });

  it('warns when avatar is started after AgentSession.start()', async () => {
    const warn = vi.fn();
    vi.spyOn(logModule, 'log').mockReturnValue({
      warn,
      debug: vi.fn(),
    } as unknown as ReturnType<typeof logModule.log>);
    vi.spyOn(jobModule, 'getJobContext').mockReturnValue(undefined);

    const session = new AvatarSession();

    await session.start(
      {
        _started: true,
        output: { audio: { constructor: { name: 'MockAudioOutput' } } },
      } as any,
      {} as any,
    );

    expect(warn).toHaveBeenCalledWith(
      { audioOutput: 'MockAudioOutput' },
      expect.stringContaining('AvatarSession.start() was called after AgentSession.start()'),
    );
  });
});
