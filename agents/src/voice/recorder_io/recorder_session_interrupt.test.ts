// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type Room, TrackPublishOptions } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { initializeLogger } from '../../log.js';
import type { Future } from '../../utils.js';
import { Agent } from '../agent.js';
import { AgentSession } from '../agent_session.js';
import { ParticipantAudioOutput } from '../room_io/_output.js';
import { FakeLLM } from '../testing/fake_llm.js';
import { RecorderIO } from './recorder_io.js';

/**
 * The customer's scenario end to end, with the real pieces: a `RecorderIO`-wrapped
 * `ParticipantAudioOutput` as `session.output.audio`, and the reply/interrupt sequence driven
 * by the real `AgentActivity` and `forwardAudio` rather than by hand.
 *
 * The recorder unit tests pin the recorder's own behavior; this one pins that the pieces
 * around it still let a session keep talking after a turn is interrupted while the output is
 * paused — the failure mode that started this whole investigation was that they did not.
 */
function frame(durationMs = 20, sampleRate = 24000): AudioFrame {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  return new AudioFrame(new Int16Array(samples), sampleRate, 1, samples);
}

/** Emits frames slowly enough that an interrupt can land mid-forwarding. */
class FrameAgent extends Agent {
  constructor() {
    super({ instructions: 'test' });
  }

  async ttsNode(): Promise<ReadableStream<AudioFrame> | null> {
    return new ReadableStream<AudioFrame>({
      async start(controller) {
        for (let i = 0; i < 25; i++) {
          controller.enqueue(frame());
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        controller.close();
      },
    });
  }
}

function makeParticipantAudioOutput(): ParticipantAudioOutput {
  const out = new ParticipantAudioOutput({} as Room, {
    sampleRate: 24000,
    numChannels: 1,
    trackPublishOptions: new TrackPublishOptions(),
  });
  // `publishTrack` normally resolves this; there is no room to publish to here.
  (out as unknown as { startedFuture: Future<void> }).startedFuture.resolve();
  return out;
}

/** Surface a stall as a value, so a hang reads as "did not settle" and not as a bare timeout. */
async function settleOrStall<T>(promise: Promise<T>, timeoutMs = 10000) {
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<'did not settle'>((resolve) => {
    timer = setTimeout(() => resolve('did not settle'), timeoutMs);
  });
  try {
    return await Promise.race([promise, watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('AgentSession recording a real ParticipantAudioOutput', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('keeps answering after a turn interrupted while the output was paused', async () => {
    const session = new AgentSession({
      llm: new FakeLLM([
        { input: 'one', content: 'first spoken reply from the agent.' },
        { input: 'two', content: 'second spoken reply from the agent.' },
        { input: 'three', content: 'third spoken reply from the agent.' },
      ]),
    });
    // Mirrors what `AgentSession.start` does when recording is enabled.
    const recorder = new RecorderIO({ agentSession: session });
    session.output.audio = recorder.recordOutput(makeParticipantAudioOutput());

    await session.start({ agent: new FrameAgent() });
    try {
      // A plain interrupted turn. This also latches `ParticipantAudioOutput`'s
      // `interruptedFuture`, which is what makes the next turn's frames droppable.
      const first = session.generateReply({ userInput: 'one' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      session.interrupt({ force: true });
      expect(await settleOrStall(first.waitForPlayout())).not.toBe('did not settle');

      // The false-interruption pause (`agent_activity.ts` pauses the output when the user
      // starts talking while the agent is thinking), followed by a confirmed interrupt. Frames
      // sitting at the pause gate are released without the sink ever counting them.
      const second = session.generateReply({ userInput: 'two' });
      await new Promise((resolve) => setTimeout(resolve, 60));
      session.output.audio!.pause();
      await new Promise((resolve) => setTimeout(resolve, 60));
      session.interrupt({ force: true });
      expect(await settleOrStall(second.waitForPlayout())).not.toBe('did not settle');

      // The part the customer never got: the session still speaks.
      session.output.audio!.resume();
      const third = session.generateReply({ userInput: 'three' });
      expect(await settleOrStall(third.waitForPlayout())).not.toBe('did not settle');
    } finally {
      await settleOrStall(session.close(), 5000);
    }
  }, 60000);
});
