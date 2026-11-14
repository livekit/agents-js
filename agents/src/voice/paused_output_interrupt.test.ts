// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type Room, TrackPublishOptions } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import type { VADEvent } from '../vad.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { TextOutput, type TimedString, isTimedString } from './io.js';
import { RecorderIO } from './recorder_io/recorder_io.js';
import { ParticipantAudioOutput } from './room_io/_output.js';
import type { SpeechHandle } from './speech_handle.js';
import { FakeLLM } from './testing/fake_llm.js';
import { TranscriptionSynchronizer } from './transcription/synchronizer.js';

/**
 * Interrupting a reply while false-interruption handling holds a frame at the room output's pause
 * gate used to wait out the 2 s reply cancel timeout (5 s for resampled audio and `say()`).
 */

const REPLY = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';

function frames(sampleRate: number, count: number): ReadableStream<AudioFrame> {
  const samples = sampleRate / 50;
  return new ReadableStream<AudioFrame>({
    async start(controller) {
      for (let i = 0; i < count; i++) {
        controller.enqueue(new AudioFrame(new Int16Array(samples), sampleRate, 1, samples));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      controller.close();
    },
  });
}

/** Speaks `longReplies` long replies, then short ones. */
class FrameAgent extends Agent {
  constructor(
    private readonly sampleRate: number,
    private longReplies: number,
  ) {
    super({ instructions: 'test' });
  }

  async ttsNode(): Promise<ReadableStream<AudioFrame> | null> {
    return frames(this.sampleRate, this.longReplies-- > 0 ? 200 : 5);
  }
}

class RecordingTextOutput extends TextOutput {
  text = '';
  async captureText(text: string | TimedString): Promise<void> {
    this.text += isTimedString(text) ? text.text : text;
  }
  flush(): void {}
}

type Chain = 'room' | 'synced' | 'recorded';

type ActivityHooks = {
  onVADInferenceDone(ev: VADEvent): void;
  pausedSpeech?: { handle: SpeechHandle };
};

type AudioSourceHooks = { clearQueue(): void; captureFrame(frame: AudioFrame): Promise<void> };

async function startSession(chain: Chain, sampleRate: number, longReplies = 1) {
  initializeLogger({ pretty: false, level: 'silent' });
  const session = new AgentSession({
    aecWarmupDuration: null,
    llm: new FakeLLM([
      { input: 'first', content: REPLY },
      { input: 'second', content: 'second reply' },
    ]),
  });

  const room = new ParticipantAudioOutput({} as Room, {
    sampleRate: 24000,
    numChannels: 1,
    trackPublishOptions: new TrackPublishOptions(),
  });
  // `publishTrack` resolves this once a participant subscribes; there is no room here.
  (room as unknown as { startedFuture: { resolve(): void } }).startedFuture.resolve();
  const audioSource = (room as unknown as { audioSource: AudioSourceHooks }).audioSource;
  // Only the pause gate clears the queue before the interruption, right before it holds a frame.
  const clearQueue = vi.spyOn(audioSource, 'clearQueue');
  const sourceCapture = vi.spyOn(audioSource, 'captureFrame');

  const text = new RecordingTextOutput();
  if (chain === 'room') {
    session.output.audio = room;
  } else {
    const synchronizer = new TranscriptionSynchronizer(room, text);
    session.output.transcription = synchronizer.textOutput;
    session.output.audio =
      chain === 'synced'
        ? synchronizer.audioOutput
        : new RecorderIO({ agentSession: session }).recordOutput(synchronizer.audioOutput);
  }

  await session.start({ agent: new FrameAgent(sampleRate, longReplies) });
  const activity = (session as unknown as { activity: ActivityHooks }).activity;

  return {
    session,
    activity,
    /** Resolves once the reply is audible, and for synced chains once its first words are out. */
    async heard() {
      await vi.waitFor(() => {
        expect(session.agentState).toBe('speaking');
        if (chain !== 'room') expect(text.text).toContain('charlie');
      }, 3000);
    },
    /** VAD reports the user talking over the agent; the activity pauses the output. */
    userStartsTalking() {
      activity.onVADInferenceDone({
        speechDuration: 1000,
        speaking: true,
        rawAccumulatedSilence: 0,
      } as VADEvent);
    },
    userStopsTalking() {
      activity.onVADInferenceDone({
        speechDuration: 0,
        speaking: false,
        rawAccumulatedSilence: 1000,
      } as VADEvent);
    },
    async frameHeld() {
      await vi.waitFor(() => expect(clearQueue).toHaveBeenCalled());
    },
    sourceFrames: () => sourceCapture.mock.calls.length,
  };
}

function assistantMessages(session: AgentSession) {
  return session.history.items.flatMap((item) =>
    item.type === 'message' && item.role === 'assistant'
      ? [{ text: item.textContent ?? '', interrupted: item.interrupted }]
      : [],
  );
}

describe('interrupting a reply while false-interruption handling pauses the output', () => {
  it.each([
    { chain: 'room', sampleRate: 24000 },
    { chain: 'room', sampleRate: 16000 },
    { chain: 'synced', sampleRate: 24000 },
    { chain: 'synced', sampleRate: 16000 },
    { chain: 'recorded', sampleRate: 24000 },
    { chain: 'recorded', sampleRate: 16000 },
  ] as const)(
    'finishes the reply at once and plays the next one ($chain, $sampleRate Hz TTS)',
    async ({ chain, sampleRate }) => {
      const t = await startSession(chain, sampleRate);
      const { session, activity } = t;
      try {
        const first = session.generateReply({ userInput: 'first' });
        await t.heard();
        t.userStartsTalking();
        expect(activity.pausedSpeech?.handle).toBe(first);
        await t.frameHeld();

        const sourceFrames = t.sourceFrames();
        const startedAt = performance.now();
        session.interrupt();
        await first.waitForPlayout();
        expect(performance.now() - startedAt).toBeLessThan(500);
        // the held frame was dropped, not played
        expect(t.sourceFrames()).toBe(sourceFrames);

        t.userStopsTalking();
        await session.generateReply({ userInput: 'second' }).waitForPlayout();

        const messages = assistantMessages(session);
        expect(messages).toHaveLength(2);
        expect(messages[1]).toEqual({ text: 'second reply', interrupted: false });
        expect(messages[0]!.interrupted).toBe(true);
        if (chain !== 'room') {
          // the synchronized transcript stops where playback stopped
          expect(messages[0]!.text).not.toBe(REPLY);
          expect(REPLY.startsWith(messages[0]!.text)).toBe(true);
        }
      } finally {
        await session.close();
      }
    },
    15_000,
  );

  it('finishes an interrupted say() at once and plays the next reply', async () => {
    const t = await startSession('room', 24000, 0);
    const { session, activity } = t;
    try {
      const speech = session.say('hello there', { audio: frames(24000, 200) });
      await t.heard();
      t.userStartsTalking();
      expect(activity.pausedSpeech?.handle).toBe(speech);
      await t.frameHeld();

      const sourceFrames = t.sourceFrames();
      const startedAt = performance.now();
      session.interrupt();
      await speech.waitForPlayout();
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(t.sourceFrames()).toBe(sourceFrames);

      t.userStopsTalking();
      await session.generateReply({ userInput: 'second' }).waitForPlayout();
      expect(assistantMessages(session).at(-1)).toEqual({
        text: 'second reply',
        interrupted: false,
      });
    } finally {
      await session.close();
    }
  }, 15_000);
});
