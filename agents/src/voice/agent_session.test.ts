// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, CloseReason } from './events.js';

type CloseImplInner = (reason: CloseReason, error: null, drain: boolean) => Promise<void>;

describe('AgentSession close lifecycle', () => {
  it('emits close before closing RoomIO so RoomIO close handlers can run', async () => {
    let closeEmitted = false;
    const roomIO = {
      close: vi.fn(async () => {
        expect(closeEmitted).toBe(true);
      }),
    };
    const session = {
      started: true,
      closing: false,
      activity: undefined,
      _recorderIO: undefined,
      input: { audio: null },
      output: { audio: null, transcription: null },
      sessionHost: undefined,
      _roomIO: roomIO,
      sessionSpan: undefined,
      _userSpeakingSpan: undefined,
      agentSpeakingSpan: undefined,
      logger: { info: vi.fn() },
      llmErrorCounts: 0,
      ttsErrorCounts: 0,
      _userState: 'listening',
      _agentState: 'listening',
      rootSpanContext: undefined,
      _cancelUserAwayTimer: vi.fn(),
      _onAecWarmupExpired: vi.fn(),
      off: vi.fn(),
      emit: vi.fn((event: AgentSessionEventTypes) => {
        if (event === AgentSessionEventTypes.Close) {
          closeEmitted = true;
        }
      }),
    };

    const closeImplInner = (AgentSession.prototype as unknown as { closeImplInner: CloseImplInner })
      .closeImplInner;
    await closeImplInner.call(session, CloseReason.USER_INITIATED, null, false);

    expect(roomIO.close).toHaveBeenCalledTimes(1);
    expect(closeEmitted).toBe(true);
  });
});
