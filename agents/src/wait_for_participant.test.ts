// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { RemoteParticipant } from '@livekit/rtc-node';
import { ParticipantKind, ParticipantState, Room, RoomEvent } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { isPending } from './utils.js';
import { waitForParticipant } from './utils.js';

/** A Room stub exposing only what waitForParticipant touches. */
const mockRoom = () => {
  const room = new Room();
  vi.spyOn(room, 'isConnected', 'get').mockReturnValue(true);
  return room;
};

const makeParticipant = (
  identity: string,
  state: ParticipantState,
  kind: ParticipantKind = ParticipantKind.STANDARD,
): RemoteParticipant => ({ identity, state, kind }) as unknown as RemoteParticipant;

/** Add a participant to the room the way the SDK's participantConnected handler would. */
const connect = (room: Room, p: RemoteParticipant) => {
  room.remoteParticipants.set(p.identity, p);
};

/** Promote a participant the way the SDK's participantActive handler would. */
const activate = (room: Room, p: RemoteParticipant) => {
  (p as { state: ParticipantState }).state = ParticipantState.ACTIVE;
  room.emit(RoomEvent.ParticipantActive, p);
};

describe('waitForParticipant', () => {
  it('returns immediately for an already-active participant', async () => {
    const room = mockRoom();
    const alice = makeParticipant('alice', ParticipantState.ACTIVE);
    connect(room, alice);

    await expect(waitForParticipant({ room, identity: 'alice' })).resolves.toBe(alice);
  });

  it('keeps waiting for a participant that has connected but is not active yet', async () => {
    const room = mockRoom();
    const alice = makeParticipant('alice', ParticipantState.JOINED);
    connect(room, alice);

    const pending = waitForParticipant({ room, identity: 'alice' });
    expect(await isPending(pending)).toBe(true);

    activate(room, alice);
    await expect(pending).resolves.toBe(alice);
  });

  it('resolves on the ParticipantActive event for a participant that joins later', async () => {
    const room = mockRoom();
    const pending = waitForParticipant({ room, identity: 'alice' });
    expect(await isPending(pending)).toBe(true);

    const alice = makeParticipant('alice', ParticipantState.JOINED);
    connect(room, alice);
    // connecting alone must not resolve the wait
    expect(await isPending(pending)).toBe(true);

    activate(room, alice);
    await expect(pending).resolves.toBe(alice);
  });

  it('ignores an active participant with a different identity', async () => {
    const room = mockRoom();
    connect(room, makeParticipant('bob', ParticipantState.ACTIVE));

    const pending = waitForParticipant({ room, identity: 'alice' });
    expect(await isPending(pending)).toBe(true);

    const alice = makeParticipant('alice', ParticipantState.JOINED);
    connect(room, alice);
    activate(room, alice);
    await expect(pending).resolves.toBe(alice);
  });

  it('honours the kind filter', async () => {
    const room = mockRoom();
    const standard = makeParticipant('standard', ParticipantState.ACTIVE);
    connect(room, standard);

    const pending = waitForParticipant({ room, kind: ParticipantKind.AGENT });
    expect(await isPending(pending)).toBe(true);

    const agent = makeParticipant('agent', ParticipantState.JOINED, ParticipantKind.AGENT);
    connect(room, agent);
    activate(room, agent);
    await expect(pending).resolves.toBe(agent);
  });

  it('rejects when the room disconnects while waiting', async () => {
    const room = mockRoom();
    connect(room, makeParticipant('alice', ParticipantState.JOINED));

    const pending = waitForParticipant({ room, identity: 'alice' });
    room.emit(RoomEvent.Disconnected, undefined as never);

    await expect(pending).rejects.toThrow('Got disconnected from room while waiting');
  });

  it('rejects when the abort signal fires', async () => {
    const room = mockRoom();
    connect(room, makeParticipant('alice', ParticipantState.JOINED));

    const controller = new AbortController();
    const pending = waitForParticipant({ room, identity: 'alice', signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow('waitForParticipant aborted');
  });

  it('returns the local participant without waiting on remote state', async () => {
    const room = mockRoom();
    const local = { identity: 'agent', kind: ParticipantKind.AGENT };
    room.localParticipant = local as unknown as NonNullable<Room['localParticipant']>;

    await expect(waitForParticipant({ room, identity: 'agent', includeLocal: true })).resolves.toBe(
      local,
    );
  });
});
