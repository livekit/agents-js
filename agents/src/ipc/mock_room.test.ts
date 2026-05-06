// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Job, JobType, ParticipantInfo_State, Room as ProtoRoom } from '@livekit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { JobContext, JobProcess, type RunningJobInfo } from '../job.js';
import { createMockRoom } from './mock_room.js';

function createMockJobContext() {
  const room = createMockRoom();
  const onConnect = vi.fn();
  const onShutdown = vi.fn();
  const runningJob: RunningJobInfo = {
    acceptArguments: { identity: 'console', name: '', metadata: '' },
    fakeJob: true,
    job: new Job({
      id: 'mock-job',
      room: new ProtoRoom({ name: 'console', sid: 'RM_mock_sid' }),
      type: JobType.JT_ROOM,
    }),
    token: 'fake_token',
    url: 'ws://fake-url',
    workerId: 'fake_worker',
  };
  const ctx = new JobContext(new JobProcess(), runningJob, room, onConnect, onShutdown, {
    doInference: vi.fn(async () => undefined),
  });

  return { ctx, onConnect, room };
}

describe('createMockRoom', () => {
  it('sets the mock remote participant to active', () => {
    const room = createMockRoom();
    const participant = room.remoteParticipants.get('mock_user');

    expect(participant).toBeDefined();
    expect(participant?.identity).toBe('mock_user');
    expect(participant?.sid).toBe('PA_mock_user');
    expect(participant?.info.state).toBe(ParticipantInfo_State.ACTIVE);
  });

  it('satisfies JobContext.waitForParticipant immediately', async () => {
    const { ctx } = createMockJobContext();

    await expect(ctx.waitForParticipant()).resolves.toMatchObject({ identity: 'mock_user' });
  });

  it('replays existing participants to participant entrypoints on connect', async () => {
    const { ctx, onConnect } = createMockJobContext();
    const participantEntrypoint = vi.fn(async () => {});

    ctx.addParticipantEntrypoint(participantEntrypoint);
    await ctx.connect();

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(participantEntrypoint).toHaveBeenCalledTimes(1);
    expect(participantEntrypoint.mock.calls[0]?.[1].identity).toBe('mock_user');
  });
});
