// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Job } from '@livekit/protocol';
import { Room } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobContext, JobProcess } from '../../job.js';
import * as jobModule from '../../job.js';
import * as logModule from '../../log.js';
import { AgentSession } from '../agent_session.js';
import { AudioOutput } from '../io.js';
import { AvatarSession } from './avatar_session.js';

const { removeParticipantMock, roomServiceClientMock } = vi.hoisted(() => ({
  removeParticipantMock: vi.fn(),
  roomServiceClientMock: vi.fn(function RoomServiceClient() {
    return { removeParticipant: removeParticipantMock };
  }),
}));

vi.mock('livekit-server-sdk', () => ({
  RoomServiceClient: roomServiceClientMock,
}));

describe('AvatarSession base', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const mockAgentSession = ({ started = false, audioOutput = null } = {}) => {
    const session = new TestAgentSession(started);
    session.output.audio = audioOutput;
    return {
      session,
      on: vi.spyOn(session, 'on'),
      off: vi.spyOn(session, 'off'),
    };
  };

  const mockRoom = () => {
    const room = new Room();
    let isConnected = false;
    vi.spyOn(room, 'name', 'get').mockReturnValue('test-room');
    vi.spyOn(room, 'isConnected', 'get').mockImplementation(() => isConnected);
    return {
      room,
      on: vi.spyOn(room, 'on'),
      off: vi.spyOn(room, 'off'),
      connect: () => {
        isConnected = true;
      },
    };
  };

  const mockJobContext = (room = new Room()) => {
    const context = new JobContext(
      new JobProcess(),
      {
        job: new Job({ id: 'test-job' }),
        url: 'wss://example.livekit.cloud',
        token: 'token',
        workerId: 'worker-id',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      },
      room,
      vi.fn(),
      vi.fn(),
      { doInference: vi.fn() },
    );
    vi.spyOn(jobModule, 'getJobContext').mockReturnValue(context);
    return context;
  };

  class TestAgentSession extends AgentSession {
    constructor(private readonly started: boolean) {
      super({ vad: null, turnHandling: { turnDetection: null } });
    }

    override get _started(): boolean {
      return this.started;
    }
  }

  class MockAudioOutput extends AudioOutput {
    override clearBuffer(): void {}
  }

  class TestAvatarSession extends AvatarSession {
    override get avatarIdentity(): string {
      return 'avatar-identity';
    }
  }

  it('registers aclose with job shutdown callback', async () => {
    let shutdownCallback: (() => Promise<void>) | undefined;
    const addShutdownCallback = vi.fn((cb: () => Promise<void>) => {
      shutdownCallback = cb;
    });
    const jobContext = mockJobContext();
    vi.spyOn(jobContext, 'addShutdownCallback').mockImplementation(addShutdownCallback);

    const session = new AvatarSession();
    const acloseSpy = vi.spyOn(session, 'aclose').mockResolvedValue();
    const agentSession = mockAgentSession();
    const room = mockRoom();

    await session.start(agentSession.session, room.room);

    expect(addShutdownCallback).toHaveBeenCalledTimes(1);
    expect(shutdownCallback).toBeTypeOf('function');

    await shutdownCallback?.();
    expect(acloseSpy).toHaveBeenCalledTimes(1);
  });

  it('warns when avatar is started after AgentSession.start()', async () => {
    const warn = vi.fn();
    vi.spyOn(logModule.log(), 'warn').mockImplementation(warn);
    vi.spyOn(jobModule, 'getJobContext').mockReturnValue(undefined);

    const session = new AvatarSession();
    const agentSession = mockAgentSession({
      started: true,
      audioOutput: new MockAudioOutput(),
    });
    const room = mockRoom();

    await session.start(agentSession.session, room.room);

    expect(warn).toHaveBeenCalledWith(
      { audioOutput: 'MockAudioOutput' },
      expect.stringContaining('AvatarSession.start() was called after AgentSession.start()'),
    );
  });

  it('logs at debug and completes cleanup when the avatar participant is not found', async () => {
    const debug = vi.fn();
    const warn = vi.fn();
    vi.spyOn(logModule.log(), 'debug').mockImplementation(debug);
    vi.spyOn(logModule.log(), 'warn').mockImplementation(warn);
    mockJobContext();
    removeParticipantMock.mockRejectedValueOnce({ code: 'not_found' });

    const agentSession = mockAgentSession();
    const room = mockRoom();
    const session = new TestAvatarSession();
    await session.start(agentSession.session, room.room);
    room.connect();

    await expect(session.aclose()).resolves.toBeUndefined();

    expect(removeParticipantMock).toHaveBeenCalledWith('test-room', 'avatar-identity');
    expect(debug).toHaveBeenCalledWith(
      { identity: 'avatar-identity' },
      'avatar participant not in room, skipping removal',
    );
    expect(warn).not.toHaveBeenCalled();
    expect(agentSession.off).toHaveBeenCalledWith(...agentSession.on.mock.calls[0]!);
    expect(room.off).toHaveBeenCalledWith(...room.on.mock.calls[0]!);
  });

  it('warns with the original error and completes cleanup when participant removal fails', async () => {
    const debug = vi.fn();
    const warn = vi.fn();
    vi.spyOn(logModule.log(), 'debug').mockImplementation(debug);
    vi.spyOn(logModule.log(), 'warn').mockImplementation(warn);
    mockJobContext();
    const error = new Error('remove failed');
    removeParticipantMock.mockRejectedValueOnce(error);

    const agentSession = mockAgentSession();
    const room = mockRoom();
    const session = new TestAvatarSession();
    await session.start(agentSession.session, room.room);
    room.connect();

    await expect(session.aclose()).resolves.toBeUndefined();

    expect(removeParticipantMock).toHaveBeenCalledWith('test-room', 'avatar-identity');
    expect(warn).toHaveBeenCalledWith(
      { error, identity: 'avatar-identity' },
      'failed to remove avatar participant',
    );
    expect(debug).not.toHaveBeenCalledWith(
      expect.anything(),
      'avatar participant not in room, skipping removal',
    );
    expect(agentSession.off).toHaveBeenCalledWith(...agentSession.on.mock.calls[0]!);
    expect(room.off).toHaveBeenCalledWith(...room.on.mock.calls[0]!);
  });
});
