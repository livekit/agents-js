// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import type { SpeechEvent } from '../stt/stt.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import type { STTNode } from './io.js';
import { createSilenceFrame, createSilenceFrameLike } from './utils.js';

function createHooks(): RecognitionHooks {
  return {
    onInterruption: vi.fn(),
    onStartOfSpeech: vi.fn(),
    onVADInferenceDone: vi.fn(),
    onEndOfSpeech: vi.fn(),
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onEndOfTurn: vi.fn(async () => true),
    onPreemptiveGeneration: vi.fn(),
    retrieveChatCtx: () => ChatContext.empty(),
  };
}

function markerFrame(byte: number, samples = 160, sampleRate = 16000): AudioFrame {
  const data = new Int16Array(samples).fill(byte);
  return new AudioFrame(data, sampleRate, 1, samples);
}

function isAllZero(frame: AudioFrame): boolean {
  for (const v of frame.data) {
    if (v !== 0) return false;
  }
  return true;
}

async function flushTasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(check: () => boolean, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await flushTasks();
  }
}

describe('createSilenceFrame helpers', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('produces a zeroed mono frame of the requested duration in ms', () => {
    const frame = createSilenceFrame(500, 16000);
    expect(frame.sampleRate).toBe(16000);
    expect(frame.channels).toBe(1);
    expect(frame.samplesPerChannel).toBe(8000);
    expect(frame.data.length).toBe(8000);
    expect(isAllZero(frame)).toBe(true);
  });

  it('honours numChannels for multi-channel silence', () => {
    const frame = createSilenceFrame(100, 24000, 2);
    expect(frame.samplesPerChannel).toBe(2400);
    expect(frame.channels).toBe(2);
    expect(frame.data.length).toBe(4800);
    expect(isAllZero(frame)).toBe(true);
  });

  it('createSilenceFrameLike matches the source shape with zeroed samples', () => {
    const src = markerFrame(0x11, 160, 16000);
    const silence = createSilenceFrameLike(src);
    expect(silence.sampleRate).toBe(src.sampleRate);
    expect(silence.channels).toBe(src.channels);
    expect(silence.samplesPerChannel).toBe(src.samplesPerChannel);
    expect(silence.data.length).toBe(src.data.length);
    expect(isAllZero(silence)).toBe(true);
  });
});

describe('AudioRecognition substitutes silence on the STT path only', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('forwards the real frame to every consumer when no discard predicate is set', async () => {
    const sttFrames: AudioFrame[] = [];
    const sttNode: STTNode = async (audioStream) => {
      void (async () => {
        const reader = audioStream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            sttFrames.push(value);
          }
        } catch {
          /* stream closed */
        }
      })();
      return new ReadableStream<SpeechEvent | string>({ start() {} });
    };

    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      stt: sttNode,
      minEndpointingDelay: 0,
      maxEndpointingDelay: 0,
    });

    const subscriberStream = recognition.subscribeAudioStream();
    const subscriberFrames: AudioFrame[] = [];
    const subscriberDone = (async () => {
      const reader = subscriberStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          subscriberFrames.push(value);
        }
      } catch {
        /* stream closed */
      }
    })();

    try {
      await recognition.start();
      recognition.setInputAudioStream(
        new ReadableStream<AudioFrame>({
          start(controller) {
            controller.enqueue(markerFrame(0x11));
            controller.enqueue(markerFrame(0x22));
            controller.close();
          },
        }),
      );

      await waitFor(() => sttFrames.length === 2 && subscriberFrames.length === 2);
      expect(sttFrames.map((f) => f.data[0])).toEqual([0x11, 0x22]);
      expect(subscriberFrames.map((f) => f.data[0])).toEqual([0x11, 0x22]);
    } finally {
      await recognition.close();
      await subscriberDone;
    }
  });

  it('substitutes silence on the STT path while subscribers still see real frames', async () => {
    const DISCARD_MARKER = 0x22;
    const sttFrames: AudioFrame[] = [];
    const sttNode: STTNode = async (audioStream) => {
      void (async () => {
        const reader = audioStream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            sttFrames.push(value);
          }
        } catch {
          /* stream closed */
        }
      })();
      return new ReadableStream<SpeechEvent | string>({ start() {} });
    };

    // The predicate inspects the frame so the discard signal travels with the
    // data — independent of stream-scheduling timing.
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      stt: sttNode,
      shouldDiscardAudioForStt: (frame) => frame.data[0] === DISCARD_MARKER,
      minEndpointingDelay: 0,
      maxEndpointingDelay: 0,
    });

    const subscriberStream = recognition.subscribeAudioStream();
    const subscriberFrames: AudioFrame[] = [];
    const subscriberDone = (async () => {
      const reader = subscriberStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          subscriberFrames.push(value);
        }
      } catch {
        /* stream closed */
      }
    })();

    try {
      await recognition.start();
      recognition.setInputAudioStream(
        new ReadableStream<AudioFrame>({
          start(controller) {
            controller.enqueue(markerFrame(0x11));
            controller.enqueue(markerFrame(DISCARD_MARKER));
            controller.enqueue(markerFrame(DISCARD_MARKER));
            controller.enqueue(markerFrame(0x44));
            controller.close();
          },
        }),
      );

      await waitFor(() => sttFrames.length === 4 && subscriberFrames.length === 4);

      // STT path: discarded frames are replaced with silence; others pass through.
      expect(sttFrames[0]!.data[0]).toBe(0x11);
      expect(isAllZero(sttFrames[1]!)).toBe(true);
      expect(isAllZero(sttFrames[2]!)).toBe(true);
      expect(sttFrames[3]!.data[0]).toBe(0x44);

      // The silence substitutes preserve the source frame's shape.
      for (const frame of sttFrames) {
        expect(frame.sampleRate).toBe(16000);
        expect(frame.channels).toBe(1);
        expect(frame.samplesPerChannel).toBe(160);
      }

      // Subscribers branch off before the STT-only silence transform and so
      // always observe the real frames — mirroring the VAD and interruption
      // paths in the same pipeline.
      expect(subscriberFrames.map((f) => f.data[0])).toEqual([
        0x11,
        DISCARD_MARKER,
        DISCARD_MARKER,
        0x44,
      ]);
    } finally {
      await recognition.close();
      await subscriberDone;
    }
  });
});
