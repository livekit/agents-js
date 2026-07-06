// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { stt } from '@livekit/agents';
import { type AudioBuffer, initializeLogger, tokenize, tts as ttslib } from '@livekit/agents';
import { type AudioFrame, combineAudioFrames } from '@livekit/rtc-node';
import { distance } from 'fastest-levenshtein';
import { ReadableStream } from 'stream/web';
import { describe, expect, it } from 'vitest';

const TEXT =
  'The people who are crazy enough to think they can change the world are the ones who do.';

const detectCompressedContainer = (data: Uint8Array): string | undefined => {
  const startsWith = (signature: string, offset = 0) =>
    data.length >= offset + signature.length &&
    signature.split('').every((char, i) => data[offset + i] === char.charCodeAt(0));

  if (data[0] === 0xff && data.length > 1 && (data[1]! & 0xf6) === 0xf0) {
    return 'aac';
  }
  if (
    startsWith('ID3') ||
    (data[0] === 0xff && data.length > 1 && (data[1]! & 0xe0) === 0xe0 && (data[1]! & 0x06) !== 0)
  ) {
    return 'mp3';
  }
  if (startsWith('OggS')) return 'ogg';
  if (startsWith('fLaC')) return 'flac';
  if (startsWith('RIFF') && startsWith('WAVE', 8)) return 'wav';
  if (startsWith('ftyp', 4)) return 'mov,mp4,m4a,3gp,3g2,mj2';
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    return 'matroska,webm';
  }
  if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0xba) {
    return 'mpeg';
  }
};

const assertPCM = (frames: AudioFrame[]) => {
  const frame = combineAudioFrames(frames);
  const data = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  const container = detectCompressedContainer(data);

  if (container) {
    throw new Error(`Audio data isn't PCM (detected ${container})`);
  }
};

const validate = async (frames: AudioBuffer, stt: stt.STT, text: string, threshold: number) => {
  const event = await stt.recognize(frames);
  const eventText = event.alternatives![0].text.toLowerCase().replace(/\s/g, ' ').trim();
  text = text.toLowerCase().replace(/\s/g, ' ').trim();
  expect(distance(text, eventText) / text.length).toBeLessThanOrEqual(threshold);
};

export const tts = async (
  tts: ttslib.TTS,
  stt: stt.STT,
  supports: Partial<{ streaming: boolean }> = {},
) => {
  initializeLogger({ pretty: false });
  supports = { streaming: true, ...supports };
  describe('TTS', () => {
    it('should properly stream synthesize text', async () => {
      let stream: ttslib.SynthesizeStream;
      if (supports.streaming) {
        stream = tts.stream();
      } else {
        stream = new ttslib.StreamAdapter(tts, new tokenize.basic.SentenceTokenizer()).stream();
      }

      const pattern = [1, 2, 4];
      let text = TEXT;
      const chunks: string[] = [];
      const patternIter = Array(Math.ceil(text.length / pattern.reduce((sum, num) => sum + num, 0)))
        .fill(pattern)
        .flat()
        [Symbol.iterator]();

      for (const size of patternIter) {
        if (!text) break;
        chunks.push(text.slice(undefined, size));
        text = text.slice(size);
      }

      const textStream = new ReadableStream<string>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
      stream.updateInputStream(textStream);

      const frames: AudioFrame[] = [];
      for await (const event of stream) {
        if (event === ttslib.SynthesizeStream.END_OF_STREAM) break;
        frames.push(event.frame);
      }

      assertPCM(frames);
      await validate(frames, stt, TEXT, 0.2);
      stream.close();
    });
  });
};
