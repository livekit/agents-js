// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AudioByteStream,
  type VAD,
  initializeLogger,
  mergeFrames,
  stt as sttlib,
} from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import { distance } from 'fastest-levenshtein';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TRANSCRIPT =
  'It could not have been ten seconds, and yet it seemed a long time that their hands were clasped together. ' +
  'He had time to learn every detail of her hand. ' +
  'He explored the long fingers, the shapely nails, the work-hardened palm with its row of callouses, the smooth flesh under the wrist. ' +
  'Merely from feeling it he would have known it by sight. ' +
  "In the same instant it occurred to him that he did not know what colour the girl's eyes were. " +
  'They were probably brown, but people with dark hair sometimes had blue eyes. ' +
  'To turn his head and look at her would have been inconceivable folly. ' +
  'With hands locked together, invisible among the press of bodies, ' +
  'they stared steadily in front of them, and instead of the eyes of the girl, the eyes of the aged prisoner gazed mournfully at Winston out of nests of hair.';

const validate = async (text: string, transcript: string, threshold: number) => {
  text = text.toLowerCase().replace(/\s/g, ' ').trim();
  transcript = transcript.toLowerCase().replace(/\s/g, ' ').trim();
  expect(distance(text, transcript) / text.length).toBeLessThanOrEqual(threshold);
};

export const stt = async (
  stt: sttlib.STT,
  vad: VAD,
  supports: Partial<{ streaming: boolean; nonStreaming: boolean }> = {},
) => {
  initializeLogger({ pretty: false });
  supports = { streaming: true, nonStreaming: true, ...supports };
  describe('STT', async () => {
    it.skipIf(!supports.nonStreaming)('should properly transcribe speech', async () => {
      [24000, 44100].forEach(async (sampleRate) => {
        const frames = makeTestSpeech(sampleRate);
        const event = await stt.recognize(frames);
        const text = event.alternatives![0].text;
        await validate(text, TRANSCRIPT, 0.2);
        expect(event.type).toStrictEqual(sttlib.SpeechEventType.FINAL_TRANSCRIPT);
      });
    });
    it('should properly stream transcribe speech', async () => {
      [24000, 44100].forEach(async (sampleRate) => {
        const frames = makeTestSpeech(sampleRate, 10);
        let stream: sttlib.SpeechStream;
        if (supports.streaming) {
          stream = stt.stream();
        } else {
          stream = new sttlib.StreamAdapter(stt, vad).stream();
        }

        const input = async () => {
          for (const frame of frames) {
            stream.pushFrame(frame);
            await new Promise((resolve) => setTimeout(resolve, 5));
            stream.endInput();
          }
        };

        const output = async () => {
          let text = '';
          let recvStart = false;
          let recvEnd = true;

          for await (const event of stream) {
            switch (event.type) {
              case sttlib.SpeechEventType.START_OF_SPEECH:
                expect(recvEnd).toBeTruthy();
                expect(recvStart).toBeFalsy();
                recvEnd = false;
                recvStart = true;
                break;
              case sttlib.SpeechEventType.FINAL_TRANSCRIPT:
                text += event.alternatives![0].text;
                break;
              case sttlib.SpeechEventType.END_OF_SPEECH:
                recvStart = false;
                recvEnd = true;
            }
          }

          await validate(text, TRANSCRIPT, 0.2);
        };

        Promise.all([input, output]);
      });
    });
  });
};

const makeTestSpeech = (targetSampleRate: number, chunkDuration?: number): AudioFrame[] => {
  const sample = readFileSync(join(import.meta.dirname, './long.wav'));
  const channels = sample.readUInt16LE(22);
  const sampleRate = sample.readUInt32LE(24);
  const dataSize = sample.readUInt32LE(40) / 2;
  const buffer = new Int16Array(sample.buffer);

  let written = 44; // start of WAVE data stream
  const FRAME_DURATION = 1; // write 1s of audio at a time
  const numSamples = sampleRate * FRAME_DURATION;
  let frames: AudioFrame[] = [];
  while (written < dataSize) {
    const available = dataSize - written;
    const frameSize = Math.min(numSamples, available);

    frames.push(
      new AudioFrame(
        buffer.slice(written, written + frameSize),
        sampleRate,
        channels,
        Math.trunc(frameSize / channels),
      ),
    );
    written += frameSize;
  }

  if (sampleRate !== targetSampleRate) {
    const resampler = new AudioResampler(sampleRate, targetSampleRate, channels);
    const output = [];
    for (const frame of frames) {
      output.push(...resampler.push(frame));
    }
    output.push(...resampler.flush());
    frames = output;
  }

  const merged = mergeFrames(frames);
  if (!chunkDuration) {
    return [merged];
  }

  const chunkSize = (targetSampleRate * chunkDuration) / 1000;
  const bstream = new AudioByteStream(targetSampleRate, channels, chunkSize);

  // Convert Int16Array to ArrayBuffer
  const arrayBuffer = merged.data.buffer.slice(
    merged.data.byteOffset,
    merged.data.byteOffset + merged.data.byteLength,
  ) as ArrayBuffer;

  frames = bstream.write(arrayBuffer);
  frames.push(...bstream.flush());
  return frames;
};
