// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSessionEventTypes, voice } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { frontendAttributes } from './behaviors/frontend_attributes.js';
import { CHECK_IN_INSTRUCTIONS, checkInWhenUserAway } from './behaviors/user_away.js';

describe('homepage behaviors', () => {
  it('frontend attributes carry the configured TTS voice', () => {
    expect(frontendAttributes({ ttsVoice: 'Nate' })).toEqual({ tts_voice: 'Nate' });
    expect(frontendAttributes({ ttsVoice: null })).toEqual({});
  });

  it('checks in when the user is away', () => {
    const session = new voice.AgentSession({ vad: null, turnHandling: { turnDetection: null } });
    checkInWhenUserAway(session);

    const generateReply = vi
      .spyOn(session, 'generateReply')
      .mockImplementation(() => undefined as never);

    session.emit(AgentSessionEventTypes.UserStateChanged, {
      type: 'user_state_changed',
      oldState: 'listening',
      newState: 'away',
      createdAt: Date.now(),
    });

    expect(generateReply).toHaveBeenCalledWith({
      instructions: CHECK_IN_INSTRUCTIONS,
      allowInterruptions: true,
    });

    session.emit(AgentSessionEventTypes.UserStateChanged, {
      type: 'user_state_changed',
      oldState: 'away',
      newState: 'speaking',
      createdAt: Date.now(),
    });

    expect(generateReply).toHaveBeenCalledTimes(1);
  });
});
