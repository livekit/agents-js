// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import type { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import type { EndOfTurnInfo } from './audio_recognition.js';
import { AgentSessionEventTypes, type ConversationItemAddedEvent } from './events.js';
import { SpeechHandle } from './speech_handle.js';
import { FakeLLM } from './testing/fake_llm.js';

const USER_LINE = 'I already paid that yesterday';

type ActivityInternals = AgentActivity & {
  _currentSpeech?: SpeechHandle;
  _userTurnCompletedTask?: { done: boolean };
};

function endOfTurn(): EndOfTurnInfo {
  return {
    newTranscript: USER_LINE,
    transcriptConfidence: 1,
    transcriptionDelay: 0,
    endOfUtteranceDelay: 0,
    startedSpeakingAt: undefined,
    stoppedSpeakingAt: undefined,
  };
}

async function runTurn(discardAudioIfUninterruptible?: boolean) {
  const llm = new FakeLLM([{ input: USER_LINE, content: 'reply' }]);
  const chat = vi.spyOn(llm, 'chat');
  const session = new AgentSession({
    llm,
    vad: null,
    turnHandling: {
      turnDetection: null,
      interruption:
        discardAudioIfUninterruptible === undefined ? undefined : { discardAudioIfUninterruptible },
    },
  });
  session.output.setAudioEnabled(false);
  const agent = new Agent({ instructions: 'You are a collections agent.' });
  const addedUserItems: Array<string | undefined> = [];
  session.on(AgentSessionEventTypes.ConversationItemAdded, (event: ConversationItemAddedEvent) => {
    if (event.item.type === 'message' && event.item.role === 'user') {
      addedUserItems.push(event.item.textContent);
    }
  });

  await session.start({ agent });
  const activity = session._activity! as ActivityInternals;
  const speech = SpeechHandle.create({ allowInterruptions: false });
  activity._currentSpeech = speech;

  try {
    await activity.onEndOfTurn(endOfTurn());
    await vi.waitFor(() => expect(activity._userTurnCompletedTask?.done).toBe(true));

    const userMessages = agent.chatCtx.items.filter(
      (item) => item.type === 'message' && item.role === 'user',
    );
    return { addedUserItems, chat, session, speech, userMessages };
  } catch (error) {
    speech._markDone();
    activity._currentSpeech = undefined;
    await session.close().catch(() => {});
    throw error;
  }
}

async function closeTurn(result: Awaited<ReturnType<typeof runTurn>>): Promise<void> {
  result.speech._markDone();
  (result.session._activity! as ActivityInternals)._currentSpeech = undefined;
  await result.session.close();
}

describe('user turns during uninterruptible speech', () => {
  it('keeps the user turn when uninterruptible audio is retained', async () => {
    const result = await runTurn(false);
    try {
      expect(result.userMessages.map((message) => message.textContent)).toEqual([USER_LINE]);
      expect(result.addedUserItems).toEqual([USER_LINE]);
      expect(result.speech.interrupted).toBe(false);
      expect(result.chat).not.toHaveBeenCalled();
    } finally {
      await closeTurn(result);
    }
  });

  it('ignores the user turn when uninterruptible audio is discarded by default', async () => {
    const result = await runTurn();
    try {
      expect(result.userMessages).toEqual([]);
      expect(result.addedUserItems).toEqual([]);
      expect(result.speech.interrupted).toBe(false);
      expect(result.chat).not.toHaveBeenCalled();
    } finally {
      await closeTurn(result);
    }
  });
});
