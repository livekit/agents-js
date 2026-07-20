// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as jobModule from '../../job.js';
import * as logModule from '../../log.js';
import type { AgentSession } from '../agent_session.js';
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

  const mockAgentSession = (overrides: Record<string, unknown> = {}) => ({
    _started: false,
    output: { audio: null },
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  });

  const mockRoom = () => ({
    name: 'test-room',
    isConnected: false,
    on: vi.fn(),
    off: vi.fn(),
  });

  const mockJobContext = () => {
    vi.spyOn(jobModule, 'getJobContext').mockReturnValue({
      addShutdownCallback: vi.fn(),
      info: {
        url: 'wss://example.livekit.cloud',
        apiKey: 'api-key',
        apiSecret: 'api-secret',
      },
    } as unknown as ReturnType<typeof jobModule.getJobContext>);
  };

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
    vi.spyOn(jobModule, 'getJobContext').mockReturnValue({
      addShutdownCallback,
    } as unknown as ReturnType<typeof jobModule.getJobContext>);

    const session = new AvatarSession();
    const acloseSpy = vi.spyOn(session, 'aclose').mockResolvedValue();

    await session.start(
      mockAgentSession() as unknown as AgentSession,
      mockRoom() as unknown as Room,
    );

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
        ...mockAgentSession({
          _started: true,
          output: { audio: { constructor: { name: 'MockAudioOutput' } } },
        }),
      } as unknown as AgentSession,
      mockRoom() as unknown as Room,
    );

    expect(warn).toHaveBeenCalledWith(
      { audioOutput: 'MockAudioOutput' },
      expect.stringContaining('AvatarSession.start() was called after AgentSession.start()'),
    );
  });

  it('logs at debug and completes cleanup when the avatar participant is not found', async () => {
    const debug = vi.fn();
    const warn = vi.fn();
    vi.spyOn(logModule, 'log').mockReturnValue({
      debug,
      warn,
    } as unknown as ReturnType<typeof logModule.log>);
    mockJobContext();
    removeParticipantMock.mockRejectedValueOnce({ code: 'not_found' });

    const agentSession = mockAgentSession();
    const room = mockRoom();
    const session = new TestAvatarSession();
    await session.start(agentSession as unknown as AgentSession, room as unknown as Room);
    room.isConnected = true;

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
    vi.spyOn(logModule, 'log').mockReturnValue({
      debug,
      warn,
    } as unknown as ReturnType<typeof logModule.log>);
    mockJobContext();
    const error = new Error('remove failed');
    removeParticipantMock.mockRejectedValueOnce(error);

    const agentSession = mockAgentSession();
    const room = mockRoom();
    const session = new TestAvatarSession();
    await session.start(agentSession as unknown as AgentSession, room as unknown as Room);
    room.isConnected = true;

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
