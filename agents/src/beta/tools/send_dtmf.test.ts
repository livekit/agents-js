// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as jobModule from '../../job.js';
import { ToolError, type ToolOptions, ToolResult } from '../../llm/index.js';
import type { AgentSession } from '../../voice/index.js';
import { sendDtmfEvents } from './send_dtmf.js';

const { waitFor } = vi.hoisted(() => ({ waitFor: vi.fn() }));

vi.mock('node:timers/promises', () => ({ setTimeout: waitFor }));

type PublishDtmf = (code: number, digit: string) => Promise<void>;

interface TestRoom {
  localParticipant: {
    publishDtmf: PublishDtmf;
  };
}

function createRoom(publishDtmf: PublishDtmf = vi.fn()): TestRoom {
  return { localParticipant: { publishDtmf } };
}

function createToolOptions(activeRoom?: TestRoom): ToolOptions {
  const session = {
    _roomIO: activeRoom ? { rtcRoom: activeRoom } : undefined,
  } as unknown as AgentSession;

  return { ctx: { session } } as ToolOptions;
}

function mockJobRoom(room: TestRoom) {
  return vi.spyOn(jobModule, 'getJobContext').mockReturnValue({
    room,
  } as ReturnType<typeof jobModule.getJobContext>);
}

function controlPublishDelays() {
  const delays: number[] = [];
  const waiters: Array<() => void> = [];
  waitFor.mockImplementation((delay: number) => {
    delays.push(delay);
    return new Promise<void>((resolve) => waiters.push(resolve));
  });

  return {
    delays,
    async releaseNext() {
      const resolve = waiters.shift();
      expect(resolve).toBeDefined();
      resolve?.();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  waitFor.mockReset();
});

describe('sendDtmfEvents', () => {
  it('publishes exact codes and digits to the active room at 300 ms cadence', async () => {
    const published: Array<{ code: number; digit: string }> = [];
    const activeRoom = createRoom(async (code, digit) => {
      published.push({ code, digit });
    });
    const jobRoom = createRoom();
    mockJobRoom(jobRoom);
    const publishDelays = controlPublishDelays();

    const resultPromise = sendDtmfEvents.execute(
      { events: ['1', '2', '#'] },
      createToolOptions(activeRoom),
    );

    await Promise.resolve();
    expect(published).toEqual([{ code: 1, digit: '1' }]);
    expect(publishDelays.delays).toEqual([300]);

    await publishDelays.releaseNext();
    expect(published).toEqual([
      { code: 1, digit: '1' },
      { code: 2, digit: '2' },
    ]);
    expect(publishDelays.delays).toEqual([300, 300]);

    await publishDelays.releaseNext();
    expect(published).toEqual([
      { code: 1, digit: '1' },
      { code: 2, digit: '2' },
      { code: 11, digit: '#' },
    ]);
    expect(publishDelays.delays).toEqual([300, 300, 300]);
    expect(jobRoom.localParticipant.publishDtmf).not.toHaveBeenCalled();

    await publishDelays.releaseNext();
    // a successful send requests no follow-up reply
    await expect(resultPromise).resolves.toEqual(
      new ToolResult('Successfully sent DTMF events: 1, 2, #', { replyRequired: false }),
    );
  });

  it('falls back to the job room when the session has no RoomIO', async () => {
    const jobRoom = createRoom();
    mockJobRoom(jobRoom);
    const publishDelays = controlPublishDelays();

    const resultPromise = sendDtmfEvents.execute({ events: ['A'] }, createToolOptions());
    await Promise.resolve();

    expect(jobRoom.localParticipant.publishDtmf).toHaveBeenCalledExactlyOnceWith(12, 'A');
    expect(publishDelays.delays).toEqual([300]);
    await publishDelays.releaseNext();
    await expect(resultPromise).resolves.toEqual(
      new ToolResult('Successfully sent DTMF events: A', { replyRequired: false }),
    );
  });

  it('stops after a publish failure and throws a tool error without provider text', async () => {
    const activeRoom = createRoom(
      vi
        .fn<PublishDtmf>()
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error('publish failed')),
    );
    const jobRoom = createRoom();
    mockJobRoom(jobRoom);
    const publishDelays = controlPublishDelays();

    const resultPromise = sendDtmfEvents.execute(
      { events: ['1', '2', '3'] },
      createToolOptions(activeRoom),
    );
    await Promise.resolve();
    expect(publishDelays.delays).toEqual([300]);
    await publishDelays.releaseNext();

    const error = await resultPromise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).message).toBe('Failed to send DTMF events.');
    expect(activeRoom.localParticipant.publishDtmf).toHaveBeenCalledTimes(2);
    expect(activeRoom.localParticipant.publishDtmf).toHaveBeenNthCalledWith(1, 1, '1');
    expect(activeRoom.localParticipant.publishDtmf).toHaveBeenNthCalledWith(2, 2, '2');
    expect(jobRoom.localParticipant.publishDtmf).not.toHaveBeenCalled();
  });
});
