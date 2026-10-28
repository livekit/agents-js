// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession as pb } from '@livekit/protocol';
import type { ByteStreamReader, Room } from '@livekit/rtc-node';
import { type Mock, vi } from 'vitest';
import { AsyncIterableQueue } from '../../utils.js';
import { RoomSessionTransport, SessionTransport } from '../remote_session.js';

/** In-memory wire with abortable intake and an independently writable send side. */
export class InMemoryTransport extends SessionTransport {
  readonly sent: pb.AgentSessionMessage[] = [];
  private readonly incoming = new AsyncIterableQueue<pb.AgentSessionMessage>();
  closed = false;
  peer?: InMemoryTransport;
  connect(peer: InMemoryTransport): void {
    this.peer = peer;
  }
  push(message: pb.AgentSessionMessage): void {
    this.incoming.put(message);
  }
  async sendMessage(message: pb.AgentSessionMessage, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.sent.push(message);
    this.peer?.push(message);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.incoming.close();
  }
  [Symbol.asyncIterator](signal?: AbortSignal): AsyncIterator<pb.AgentSessionMessage> {
    return { next: () => this.incoming.next({ signal }) };
  }
}

export function createConnectedTransportPair(): [InMemoryTransport, InMemoryTransport] {
  const client = new InMemoryTransport();
  const host = new InMemoryTransport();
  client.connect(host);
  host.connect(client);
  return [client, host];
}

export function request(id: string, data: pb.SessionRequest['request']): pb.AgentSessionMessage {
  return new pb.AgentSessionMessage({
    message: { case: 'request', value: new pb.SessionRequest({ requestId: id, request: data }) },
  });
}
export function pingMessage(requestId: string): pb.AgentSessionMessage {
  return new pb.AgentSessionMessage({
    message: {
      case: 'request',
      value: new pb.SessionRequest({
        requestId,
        request: { case: 'ping', value: new pb.SessionRequest_Ping() },
      }),
    },
  });
}
export function messageEvent(transcript: string): pb.AgentSessionEvent {
  return new pb.AgentSessionEvent({
    event: {
      case: 'userInputTranscribed',
      value: new pb.AgentSessionEvent_UserInputTranscribed({ transcript }),
    },
  });
}

type StreamHandler = (reader: ByteStreamReader, info: { identity: string }) => void;
interface RoomTransportFixture {
  room: {
    isConnected: boolean;
    registerByteStreamHandler: Mock<(topic: string, handler: StreamHandler) => void>;
    unregisterByteStreamHandler: Mock<() => void>;
    localParticipant: {
      streamBytes: Mock<
        () => Promise<{
          write(data: Uint8Array): Promise<void>;
          close(): Promise<void>;
        }>
      >;
    };
  };
  sent: pb.AgentSessionMessage[];
  transport: RoomSessionTransport;
  deliver(message: pb.AgentSessionMessage): void;
  raw(reader: ByteStreamReader): void;
}

export function createRoomTransport({
  connected = true,
  streamError,
}: { connected?: boolean; streamError?: Error } = {}): RoomTransportFixture {
  const sent: pb.AgentSessionMessage[] = [];
  let handler!: (reader: ByteStreamReader, info: { identity: string }) => void;
  const room: RoomTransportFixture['room'] = {
    isConnected: connected,
    registerByteStreamHandler: vi.fn((_topic, cb) => {
      handler = cb;
    }),
    unregisterByteStreamHandler: vi.fn(),
    localParticipant: {
      streamBytes: vi.fn(async () => {
        if (streamError) throw streamError;
        return {
          write: async (data: Uint8Array) => {
            sent.push(pb.AgentSessionMessage.fromBinary(data));
          },
          close: async () => {},
        };
      }),
    },
  };
  const transport = new RoomSessionTransport(
    room as unknown as Room,
    { linkedParticipant: undefined } as never,
  );
  return {
    room,
    sent,
    transport,
    deliver: (msg: pb.AgentSessionMessage) =>
      handler(
        {
          readAll: async () => [msg.toBinary()],
          close: async () => {},
        } as unknown as ByteStreamReader,
        { identity: 'remote' },
      ),
    raw: (reader: ByteStreamReader) => handler(reader, { identity: 'remote' }),
  };
}
