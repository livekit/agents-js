// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { stt } from '@livekit/agents';
import { type AudioBuffer, initializeLogger, tokenize, tts as ttslib } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { distance } from 'fastest-levenshtein';
import { describe, expect, it } from 'vitest';

const TEXT =
  'The people who are crazy enough to think they can change the world are the ones who do.\n' +
  'The reasonable man adapts himself to the world; the unreasonable one persists in trying to adapt the world to himself. Therefore all progress depends on the unreasonable man.\n' +
  "Never doubt that a small group of thoughtful, committed citizens can change the world; indeed, it's the only thing that ever has.\n" +
  'Do not go where the path may lead, go instead where there is no path and leave a trail.';

const validate = async (frames: AudioBuffer, stt: stt.STT, text: string, threshold: number) => {
  const event = await stt.recognize(frames);
  const eventText = event.alternatives![0].text.toLowerCase().replace(/\s/g, ' ').trim();
  text = text.toLowerCase().replace(/\s/g, ' ').trim();
  expect(distance(text, eventText) / text.length).toBeLessThanOrEqual(threshold);
};

export const tts = async (
  tts: ttslib.TTS,
  stt: stt.STT,
  supports: Partial<{ streaming: boolean; nonStreaming: boolean }> = {},
) => {
  initializeLogger({ pretty: false });
  supports = { streaming: true, nonStreaming: true, ...supports };
  describe('TTS', () => {
    it.skipIf(!supports.nonStreaming)('should properly synthesize text', async () => {
      const synthesize = tts.synthesize(TEXT);
      const frames = await synthesize.collect();
      synthesize.close();
      await validate(frames, stt, TEXT, 0.2);
    });

    it('should properly stream synthesize tests', async () => {
      let stream: ttslib.SynthesizeStream;
      if (supports.streaming) {
        stream = tts.stream();
      } else {
        stream = new ttslib.StreamAdapter(tts, new tokenize.basic.SentenceTokenizer()).stream();
      }

      const pattern = [1, 2, 4];
      let text = TEXT;
      const chunks = [];
      const patternIter = Array(Math.ceil(text.length / pattern.reduce((sum, num) => sum + num, 0)))
        .fill(pattern)
        .flat()
        [Symbol.iterator]();

      for (const size of patternIter) {
        if (!text) break;
        chunks.push(text.slice(undefined, size));
        text = text.slice(size);
      }

      for (const chunk of chunks) {
        stream.pushText(chunk);
      }
      stream.flush();
      stream.endInput();

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
