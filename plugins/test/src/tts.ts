// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type AudioBuffer,
  AudioByteStream,
  initializeLogger,
  stt as sttlib,
  tokenize,
  tts as ttslib,
} from '@livekit/agents';
import { getFfmpegPath } from '@livekit/av';
import { type AudioFrame, combineAudioFrames } from '@livekit/rtc-node';
import { distance } from 'fastest-levenshtein';
import { spawn } from 'node:child_process';
import { ReadableStream } from 'stream/web';
import { describe, expect, it } from 'vitest';

const TEXT =
  'The people who are crazy enough to think they can change the world are the ones who do.';

const compressedFormats = new Set([
  'mp3',
  'aac',
  'ogg',
  'flac',
  'wav',
  'mov,mp4,m4a,3gp,3g2,mj2',
  'matroska,webm',
  'mpeg',
]);

const assertPCM = async (frames: AudioFrame[]) => {
  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('ffmpeg binary from @livekit/av is not available on this platform');
  }

  const frame = combineAudioFrames(frames);
  const data = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);

  const container = await new Promise<string | undefined>((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-hide_banner',
      '-probesize',
      '32',
      '-analyzeduration',
      '0',
      '-i',
      'pipe:0',
    ]);
    let stderr = '';

    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.on('error', reject);
    ffmpeg.on('close', () => {
      resolve(stderr.match(/Input #0, (.*), from 'pipe:0':/)?.[1]);
    });

    ffmpeg.stdin.end(data);
  });

  if (container && compressedFormats.has(container)) {
    throw new Error(`Audio data isn't PCM (detected ${container})`);
  }
};

const validate = async (
  frames: AudioBuffer,
  stt: sttlib.STT,
  text: string,
  threshold: number,
  streamingStt: boolean,
) => {
  let transcript = '';
  if (streamingStt) {
    const stream = stt.stream();
    let currentTranscript = '';
    const audioFrames: AudioFrame[] = Array.isArray(frames) ? frames : [frames];
    const firstFrame = audioFrames[0];
    expect(firstFrame).toBeDefined();
    const audioStream = new AudioByteStream(
      firstFrame!.sampleRate,
      firstFrame!.channels,
      firstFrame!.sampleRate / 100,
    );
    const sttFrames = audioFrames.flatMap((frame) => audioStream.write(frame.data));
    sttFrames.push(...audioStream.flush().filter((frame) => frame.samplesPerChannel > 0));
    const sendAudio = async () => {
      for (const frame of sttFrames) {
        stream.pushFrame(frame);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      stream.flush();
      stream.endInput();
    };
    const receiveTranscript = async () => {
      for await (const event of stream) {
        if (event.type === sttlib.SpeechEventType.FINAL_TRANSCRIPT) {
          currentTranscript += event.alternatives![0].text;
        } else if (event.type === sttlib.SpeechEventType.END_OF_SPEECH) {
          transcript += event.alternatives?.[0]?.text || currentTranscript;
          currentTranscript = '';
          if (transcript.length >= text.length * 0.8) {
            break;
          }
        }
      }
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([sendAudio(), receiveTranscript()]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`streaming STT validation timed out: "${transcript}"`)),
            15_000,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      stream.close();
    }
  } else {
    const event = await stt.recognize(frames);
    transcript = event.alternatives![0].text;
  }

  const eventText = transcript.toLowerCase().replace(/\s/g, ' ').trim();
  text = text.toLowerCase().replace(/\s/g, ' ').trim();
  expect(distance(text, eventText) / text.length).toBeLessThanOrEqual(threshold);
};

export const tts = async (
  tts: ttslib.TTS,
  stt: sttlib.STT,
  supports: Partial<{ streaming: boolean; streamingValidationStt: boolean }> = {},
) => {
  initializeLogger({ pretty: false });
  supports = { streaming: true, streamingValidationStt: false, ...supports };
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

      await assertPCM(frames);
      await validate(frames, stt, TEXT, 0.2, supports.streamingValidationStt!);
      stream.close();
    });
  });
};
