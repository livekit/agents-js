// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Multiple `AgentSession`s sharing one `Room` within a single job (e.g. one
 * listen-only transcriber session per remote participant, like Python's
 * multi-user-transcriber example).
 *
 * Only the primary session may own a `SessionHost`: its `RoomSessionTransport`
 * registers the room-wide `lk.agent.session` byte stream handler, and a room
 * allows a single handler per topic. Starting a secondary session must not
 * attempt a second registration (https://github.com/livekit/agents-js/issues/1927).
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as jobModule from '../job.js';
import { initializeLogger } from '../log.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { FakeLLM } from './testing/fake_llm.js';

function createFakeRoom() {
  const emitter = new EventEmitter();
  const byteStreamHandlers = new Map<string, unknown>();

  return {
    name: 'test-room',
    isConnected: true,
    remoteParticipants: new Map(),
    localParticipant: { identity: 'agent', setAttributes: vi.fn(async () => {}) },
    on: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return emitter;
    }),
    off: vi.fn((event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.off(event, listener);
      return emitter;
    }),
    registerTextStreamHandler: vi.fn(),
    unregisterTextStreamHandler: vi.fn(),
    // Mirrors @livekit/rtc-node: one byte stream handler per topic, second
    // registration throws.
    registerByteStreamHandler: vi.fn((topic: string, handler: unknown) => {
      if (byteStreamHandlers.has(topic)) {
        throw new Error(`A byte stream handler for topic "${topic}" has already been set.`);
      }
      byteStreamHandlers.set(topic, handler);
    }),
    unregisterByteStreamHandler: vi.fn((topic: string) => {
      byteStreamHandlers.delete(topic);
    }),
  };
}

function createFakeJobContext(room: ReturnType<typeof createFakeRoom>) {
  return {
    room,
    job: { enableRecording: false },
    connect: vi.fn(async () => {}),
    initRecording: vi.fn(async () => {}),
    sessionDirectory: undefined,
    _primaryAgentSession: undefined as AgentSession | undefined,
  };
}

const ioDisabled = {
  inputOptions: { audioEnabled: false, textEnabled: false },
  outputOptions: { audioEnabled: false, transcriptionEnabled: false, syncTranscription: false },
};

describe('AgentSession with a shared room', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts a secondary session without re-registering the session byte stream handler', async () => {
    const room = createFakeRoom();
    const ctx = createFakeJobContext(room);
    vi.spyOn(jobModule, 'getJobContext').mockReturnValue(
      ctx as unknown as ReturnType<typeof jobModule.getJobContext>,
    );

    const primary = new AgentSession({ llm: new FakeLLM() });
    const secondary = new AgentSession({ llm: new FakeLLM() });

    try {
      await primary.start({
        agent: new Agent({ instructions: 'primary' }),
        room: room as unknown as Parameters<AgentSession['start']>[0]['room'],
        ...ioDisabled,
      });
      expect(ctx._primaryAgentSession).toBe(primary);
      expect(room.registerByteStreamHandler).toHaveBeenCalledTimes(1);

      // Pre-fix this threw: the secondary session also created a
      // RoomSessionTransport and tried to register the room-wide handler.
      await secondary.start({
        agent: new Agent({ instructions: 'secondary' }),
        room: room as unknown as Parameters<AgentSession['start']>[0]['room'],
        ...ioDisabled,
      });
      expect(room.registerByteStreamHandler).toHaveBeenCalledTimes(1);
    } finally {
      await secondary.close().catch(() => {});
      await primary.close().catch(() => {});
    }
  });

  it('keeps the primary designation when the primary session is restarted', async () => {
    const room = createFakeRoom();
    const ctx = createFakeJobContext(room);
    vi.spyOn(jobModule, 'getJobContext').mockReturnValue(
      ctx as unknown as ReturnType<typeof jobModule.getJobContext>,
    );

    const session = new AgentSession({ llm: new FakeLLM() });
    ctx._primaryAgentSession = session;

    try {
      await session.start({
        agent: new Agent({ instructions: 'primary' }),
        room: room as unknown as Parameters<AgentSession['start']>[0]['room'],
        ...ioDisabled,
      });
      expect(room.registerByteStreamHandler).toHaveBeenCalledTimes(1);
    } finally {
      await session.close().catch(() => {});
    }
  });
});
