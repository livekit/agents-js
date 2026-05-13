// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { AgentSession } from './agent_session.js';
import { SpeechHandle } from './speech_handle.js';

describe('AgentSession.run', () => {
  it('forwards inputModality to generateReply', async () => {
    const session = new AgentSession();
    const generateReply = vi
      .spyOn(session, 'generateReply')
      .mockImplementation(() => SpeechHandle.create());

    session.run({ userInput: 'hello', inputModality: 'audio' });

    await vi.waitFor(() => {
      expect(generateReply).toHaveBeenCalledWith({
        userInput: 'hello',
        inputModality: 'audio',
      });
    });
  });
});
