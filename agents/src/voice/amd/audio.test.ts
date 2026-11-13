// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Ported from the AMD tests in Python `tests/test_audio_recognition_push_audio.py`.
 *
 * Python routes each frame through `AgentActivity.push_audio`. JS routes it through the
 * transform that `AgentActivity.attachAudioInput` puts in front of AudioRecognition and the
 * realtime session, so these tests attach one frame and read what each consumer receives.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../../log.js';
import { MultiInputStream } from '../../stream/multi_input_stream.js';
import { AgentActivity } from '../agent_activity.js';
import { AgentSession } from '../agent_session.js';
import { AMD } from './detector.js';
import { AMDLifecycle } from './events.js';

initializeLogger({ pretty: false, level: 'silent' });

interface ActivityInternals {
  agentSession: AgentSession;
  agent: { turnHandling: undefined };
  audioStream: MultiInputStream<AudioFrame>;
  audioStreamId: string | undefined;
  realtimeSession: { setInputAudioStream(stream: ReadableStream<AudioFrame>): void };
  audioRecognition: { setInputAudioStream(stream: ReadableStream<AudioFrame>): void };
  _currentSpeech: unknown;
  shouldDiscardInputAudio(): boolean;
}

function makeFrame(value = 0x11): AudioFrame {
  return new AudioFrame(new Int16Array(320).fill(value), 16_000, 1, 320);
}

/** An activity with a realtime session and AudioRecognition that record their input streams. */
function makeActivity() {
  const session = new AgentSession({ vad: undefined });
  (session as unknown as { _agentState: string })._agentState = 'listening';
  const streams: {
    realtime?: ReadableStream<AudioFrame>;
    recognition?: ReadableStream<AudioFrame>;
  } = {};
  const activity = Object.create(AgentActivity.prototype) as AgentActivity & ActivityInternals;
  Object.assign(activity, {
    agentSession: session,
    agent: { turnHandling: undefined },
    audioStream: new MultiInputStream<AudioFrame>(),
    audioStreamId: undefined,
    _currentSpeech: undefined,
    realtimeSession: {
      setInputAudioStream: (stream: ReadableStream<AudioFrame>) => {
        streams.realtime = stream;
      },
    },
    audioRecognition: {
      setInputAudioStream: (stream: ReadableStream<AudioFrame>) => {
        streams.recognition = stream;
      },
    },
  });
  return { activity, session, streams };
}

/** The first frame on `stream`, or `undefined` when none arrives in time. */
async function firstFrame(
  stream: ReadableStream<AudioFrame> | undefined,
  timeoutMs = 100,
): Promise<AudioFrame | undefined> {
  const reader = stream!.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    return result?.value;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

function attach(activity: AgentActivity, frame: AudioFrame): void {
  activity.attachAudioInput(
    new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(frame);
      },
    }),
  );
}

function isSilence(frame: AudioFrame): boolean {
  return frame.data.every((sample) => sample === 0);
}

describe('AMD session audio', () => {
  it.each([AMDLifecycle.INITIALIZED, AMDLifecycle.PENDING, AMDLifecycle.ACTIVE])(
    'amd pre answer gate discards audio for all consumers (%s)',
    async (lifecycle) => {
      const { activity, session, streams } = makeActivity();
      const amd = new AMD(session, { llm: null, stt: null });
      const pushAudio = vi.fn();
      Object.assign(amd, { _lifecycle: lifecycle, run: { stt: { pushAudio } } });
      session._setAmd(amd);
      const frame = makeFrame();
      attach(activity, frame);

      const [recognition, realtime] = await Promise.all([
        firstFrame(streams.recognition),
        firstFrame(streams.realtime),
      ]);

      if (lifecycle === AMDLifecycle.ACTIVE) {
        expect(pushAudio).toHaveBeenCalledExactlyOnceWith(frame);
      } else {
        expect(pushAudio).not.toHaveBeenCalled();
      }

      if (lifecycle === AMDLifecycle.INITIALIZED || lifecycle === AMDLifecycle.PENDING) {
        expect(recognition).toBeUndefined();
        expect(realtime).toBeUndefined();
      } else {
        expect(recognition).toBe(frame);
        expect(realtime).toBe(frame);
      }
    },
  );

  it.each(['aec_warmup', 'uninterruptible'])(
    'activity preserves amd audio when session stt is muted (%s)',
    async (guard) => {
      const { activity, session, streams } = makeActivity();
      const amd = { _blocksSessionAudio: false, pushAudio: vi.fn() };
      session._setAmd(amd as never);
      if (guard === 'aec_warmup') {
        (session as unknown as { _agentState: string })._agentState = 'speaking';
        session._aecWarmupRemaining = 1;
      } else {
        activity._currentSpeech = {
          done: () => false,
          interrupted: false,
          allowInterruptions: false,
        };
        session.sessionOptions.turnHandling.interruption.discardAudioIfUninterruptible = true;
      }
      const frame = makeFrame();
      attach(activity, frame);

      const [recognition, realtime] = await Promise.all([
        firstFrame(streams.recognition),
        firstFrame(streams.realtime),
      ]);

      expect(amd.pushAudio).toHaveBeenCalledExactlyOnceWith(frame);
      // AudioRecognition gets the real frame and mutes only its STT path through the
      // `shouldDiscardAudioForStt` predicate, which reads this guard
      expect(recognition).toBe(frame);
      expect(activity.shouldDiscardInputAudio()).toBe(true);
      expect(realtime).toBeDefined();
      expect(isSilence(realtime!)).toBe(true);
      expect(realtime!.data.length).toBe(frame.data.length);
    },
  );
});
