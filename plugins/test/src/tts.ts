// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { stt } from '@livekit/agents';
import { type AudioBuffer, initializeLogger, tokenize, tts as ttslib } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { distance } from 'fastest-levenshtein';
import { ReadableStream } from 'stream/web';
import { describe, expect, it } from 'vitest';

const TEXT =
  'The people who are crazy enough to think they can change the world are the ones who do.';

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

      await validate(frames, stt, TEXT, 0.2);
      stream.close();
    });
  });
};
