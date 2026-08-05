// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession, AgentSessionEventTypes } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { frontendAttributes } from '../../behaviors/frontend_attributes.js';
import { CHECK_IN_INSTRUCTIONS, checkInWhenUserAway } from '../../behaviors/user_away.js';

describe('behaviors', () => {
  it('carries the configured TTS voice in frontend attributes', () => {
    expect(frontendAttributes({ ttsVoice: 'Nate' })).toEqual({ tts_voice: 'Nate' });
    expect(frontendAttributes({ ttsVoice: null })).toEqual({});
  });

  it('checks in when the user is away', () => {
    const session = new AgentSession();
    const generateReply = vi.spyOn(session, 'generateReply').mockReturnValue({} as never);
    checkInWhenUserAway(session);

    session.emit(AgentSessionEventTypes.UserStateChanged, {
      type: AgentSessionEventTypes.UserStateChanged,
      oldState: 'listening',
      newState: 'away',
      createdAt: Date.now(),
    });
    expect(generateReply).toHaveBeenCalledOnce();
    expect(generateReply).toHaveBeenCalledWith({
      instructions: CHECK_IN_INSTRUCTIONS,
      allowInterruptions: true,
    });

    session.emit(AgentSessionEventTypes.UserStateChanged, {
      type: AgentSessionEventTypes.UserStateChanged,
      oldState: 'away',
      newState: 'speaking',
      createdAt: Date.now(),
    });
    expect(generateReply).toHaveBeenCalledOnce();
  });
});
