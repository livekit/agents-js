// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSessionEventTypes, type voice } from '@livekit/agents';
import { prompt } from '../prompts/index.js';

export const CHECK_IN_INSTRUCTIONS = prompt('user_away');

/** Check in once whenever the session marks the user away. */
export function checkInWhenUserAway(session: voice.AgentSession): void {
  session.on(AgentSessionEventTypes.UserStateChanged, (event) => {
    if (event.newState === 'away') {
      session.generateReply({
        instructions: CHECK_IN_INSTRUCTIONS,
        allowInterruptions: true,
      });
    }
  });
}
