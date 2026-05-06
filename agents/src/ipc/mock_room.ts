// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  ConnectionState,
  type LocalParticipant,
  ParticipantKind,
  type RemoteParticipant,
  Room,
} from '@livekit/rtc-node';

const MOCK_ROOM_SID = 'RM_mock_sid';
const MOCK_REMOTE_PARTICIPANT_IDENTITY = 'mock_user';
const MOCK_REMOTE_PARTICIPANT_SID = 'PA_mock_user';
// @livekit/rtc-node does not re-export ParticipantState; ACTIVE is 2 in the FFI enum.
const PARTICIPANT_STATE_ACTIVE = 2;

function createMockParticipant({
  identity,
  sid,
  kind,
}: {
  identity: string;
  sid: string;
  kind: ParticipantKind;
}) {
  return {
    identity,
    sid,
    kind,
    metadata: '',
    attributes: {},
    trackPublications: new Map(),
    info: {
      identity,
      sid,
      name: '',
      metadata: '',
      attributes: {},
      kind,
      kindDetails: [],
      state: PARTICIPANT_STATE_ACTIVE,
    },
  };
}

export function createMockRoom(): Room {
  const room = new Room();
  const localParticipant = createMockParticipant({
    identity: 'console',
    sid: 'PA_mock_agent',
    kind: ParticipantKind.AGENT,
  }) as unknown as LocalParticipant;
  const mockRemoteParticipant = createMockParticipant({
    identity: MOCK_REMOTE_PARTICIPANT_IDENTITY,
    sid: MOCK_REMOTE_PARTICIPANT_SID,
    kind: ParticipantKind.STANDARD,
  }) as unknown as RemoteParticipant;

  (room as unknown as { info: { sid: string; name: string; metadata: string } }).info = {
    sid: MOCK_ROOM_SID,
    name: 'console',
    metadata: '',
  };

  Object.defineProperties(room, {
    connectionState: { configurable: true, get: () => ConnectionState.CONN_CONNECTED },
    departureTimeout: { configurable: true, get: () => 0 },
    emptyTimeout: { configurable: true, get: () => 0 },
    isConnected: { configurable: true, get: () => true },
    metadata: { configurable: true, get: () => '' },
    name: { configurable: true, get: () => 'console' },
    numParticipants: { configurable: true, get: () => 2 },
    numPublishers: { configurable: true, get: () => 2 },
  });

  room.localParticipant = localParticipant;
  room.remoteParticipants = new Map([[mockRemoteParticipant.identity, mockRemoteParticipant]]);
  room.connect = async () => undefined;
  room.disconnect = async () => undefined;
  room.getSid = async () => MOCK_ROOM_SID;

  return room;
}
