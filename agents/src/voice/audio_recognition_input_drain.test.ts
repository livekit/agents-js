// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import type { SpeechEvent } from '../stt/stt.js';
import type { VAD, VADStream } from '../vad.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import type { STTNode } from './io.js';

function createHooks(): RecognitionHooks {
  return {
    interruptionByAudioActivityEnabled: false,
    onOverlapSpeech: vi.fn(),
    onBackchannelConfirmed: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onEndOfTurn: vi.fn(async () => true),
    onPreemptiveGeneration: vi.fn(),
    onAgentBackchannelOpportunity: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
  };
}

function markerFrame(byte: number, samples = 160, sampleRate = 16000): AudioFrame {
  const data = new Int16Array(samples).fill(byte);
  return new AudioFrame(data, sampleRate, 1, samples);
}

async function readAll(
  stream: ReadableStream<AudioFrame>,
  frames: AudioFrame[],
  reader = stream.getReader(),
) {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      frames.push(value);
    }
  } catch {
    /* lock released or stream closed */
  }
}

async function waitFor(check: () => boolean, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createRecordingVad(frames: AudioFrame[]): VAD {
  return {
    stream: () => {
      let reader: ReadableStreamDefaultReader<AudioFrame> | undefined;
      let closeStream!: () => void;
      const closed = new Promise<void>((resolve) => {
        closeStream = resolve;
      });
      return {
        updateInputStream(stream: ReadableStream<AudioFrame>) {
          reader = stream.getReader();
          void readAll(stream, frames, reader);
        },
        detachInputStream() {
          reader?.releaseLock();
        },
        close: () => closeStream(),
        async *[Symbol.asyncIterator]() {
          await closed;
        },
      } as unknown as VADStream;
    },
  } as unknown as VAD;
}

/**
 * Starts a recognition with no VAD and no STT (e.g. realtime_llm turn detection), pushes
 * `count` frames through it and waits until they have passed the input broadcast.
 */
async function startWithoutConsumers(count: number) {
  const recognition = new AudioRecognition({
    recognitionHooks: createHooks(),
    stt: undefined,
    vad: undefined,
    turnDetectionMode: 'realtime_llm',
    minEndpointingDelay: 0,
    maxEndpointingDelay: 0,
  });

  // the subscriber sees each frame as it passes the broadcast, before the VAD/STT branches
  const probeFrames: AudioFrame[] = [];
  void readAll(recognition.subscribeAudioStream(), probeFrames);

  let source!: ReadableStreamDefaultController<AudioFrame>;
  await recognition.start();
  recognition.setInputAudioStream(
    new ReadableStream<AudioFrame>({
      start(controller) {
        source = controller;
      },
    }),
  );

  for (let i = 0; i < count; i++) {
    source.enqueue(markerFrame(0x11));
  }
  await waitFor(() => probeFrames.length === count);
  // the tee and the drain only chain promises, so one macrotask lets them settle completely
  await new Promise((resolve) => setTimeout(resolve, 0));

  return { recognition, push: (frame: AudioFrame) => source.enqueue(frame) };
}

describe('AudioRecognition without a VAD or STT consumer', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('does not buffer input audio for an STT attached later', async () => {
    const { recognition, push } = await startWithoutConsumers(100);
    const sttFrames: AudioFrame[] = [];
    const sttNode: STTNode = async (audioStream) => {
      void readAll(audioStream, sttFrames);
      return new ReadableStream<SpeechEvent | string>({ start() {} });
    };

    try {
      await recognition.updateStt(sttNode);
      push(markerFrame(0x22));
      push(markerFrame(0x33));

      await waitFor(() => sttFrames.some((f) => f.data[0] === 0x33));
      expect(sttFrames.map((f) => f.data[0])).toEqual([0x22, 0x33]);
    } finally {
      await recognition.close();
    }
  });

  it('does not buffer input audio for a VAD attached later', async () => {
    const { recognition, push } = await startWithoutConsumers(100);
    const vadFrames: AudioFrame[] = [];

    try {
      await recognition.updateVad(createRecordingVad(vadFrames));
      push(markerFrame(0x22));
      push(markerFrame(0x33));

      await waitFor(() => vadFrames.some((f) => f.data[0] === 0x33));
      expect(vadFrames.map((f) => f.data[0])).toEqual([0x22, 0x33]);
    } finally {
      await recognition.close();
    }
  });
});
