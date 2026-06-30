// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { voice } from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';
import { log } from '../log.js';

const HEADER_SIZE = 5;
const DEFAULT_STT_RATE = 16000;
const STT_CHANNELS = 1;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

const logger = log();

function deserializeFrame(payload: Buffer): AudioFrame | null {
  if (payload.byteLength < HEADER_SIZE) {
    return null;
  }

  const sampleRate = payload.readUInt32LE(0) || DEFAULT_STT_RATE;
  const channels = payload.readUInt8(4) || 1;
  const pcm = payload.subarray(HEADER_SIZE);
  const samplesPerChannel = Math.floor(pcm.byteLength / 2 / channels);
  if (samplesPerChannel <= 0) {
    return null;
  }

  const frameBytes = samplesPerChannel * channels * 2;
  const data = new Int16Array(
    pcm.buffer,
    pcm.byteOffset,
    Math.floor(frameBytes / Int16Array.BYTES_PER_ELEMENT),
  );
  return new AudioFrame(new Int16Array(data), sampleRate, channels, samplesPerChannel);
}

function downmixToMono(frame: AudioFrame): AudioFrame {
  if (frame.channels === 1) {
    return frame;
  }

  const input = frame.data;
  const output = new Int16Array(frame.samplesPerChannel);
  for (let sample = 0; sample < frame.samplesPerChannel; sample++) {
    let sum = 0;
    for (let channel = 0; channel < frame.channels; channel++) {
      sum += input[sample * frame.channels + channel] ?? 0;
    }
    output[sample] = Math.round(sum / frame.channels);
  }

  return new AudioFrame(output, frame.sampleRate, STT_CHANNELS, frame.samplesPerChannel);
}

export class MeetingAudioInput extends voice.AudioInput {
  private rateOut: number;
  private queueSize: number;
  private controller?: ReadableStreamDefaultController<AudioFrame>;
  private queue: AudioFrame[] = [];
  private resampler?: AudioResampler;
  private resamplerInRate?: number;

  constructor({ rateOut = DEFAULT_STT_RATE, queueSize = 100 } = {}) {
    super();
    this.rateOut = rateOut;
    this.queueSize = queueSize;
    this.multiStream.addInputStream(
      new ReadableStream<AudioFrame>({
        start: (controller) => {
          this.controller = controller;
        },
      }),
    );
  }

  submit(payload: Buffer): void {
    const frame = deserializeFrame(payload);
    if (!frame) {
      return;
    }

    for (const out of this.resample(downmixToMono(frame))) {
      this.enqueue(out);
    }
  }

  private enqueue(frame: AudioFrame): void {
    if (
      !this.controller ||
      this.controller.desiredSize === null ||
      this.controller.desiredSize <= 0
    ) {
      if (this.queue.length >= this.queueSize) {
        this.queue.shift();
      }
      this.queue.push(frame);
      return;
    }

    this.controller.enqueue(frame);
    while (this.queue.length > 0 && (this.controller.desiredSize ?? 0) > 0) {
      this.controller.enqueue(this.queue.shift()!);
    }
  }

  private resample(frame: AudioFrame): AudioFrame[] {
    if (frame.sampleRate === this.rateOut) {
      return [frame];
    }
    if (!this.resampler || this.resamplerInRate !== frame.sampleRate) {
      this.resampler = new AudioResampler(frame.sampleRate, this.rateOut, frame.channels);
      this.resamplerInRate = frame.sampleRate;
    }
    return this.resampler.push(frame);
  }
}

export async function streamMeetingRelay({
  websocketUrl,
  audioSink,
  chatSink,
  signal,
  reconnectDelay = INITIAL_RECONNECT_DELAY_MS,
  maxReconnectDelay = MAX_RECONNECT_DELAY_MS,
}: {
  websocketUrl: string;
  audioSink: (payload: Buffer) => void;
  chatSink?: (payload: string) => void;
  signal: AbortSignal;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
}): Promise<void> {
  let backoffTime = reconnectDelay;
  while (!signal.aborted) {
    try {
      await streamOnce({ websocketUrl, audioSink, chatSink, signal });
      backoffTime = reconnectDelay;
    } catch (error) {
      if (signal.aborted) {
        break;
      }
      logger.warn({ error, retryInMs: backoffTime }, 'meeting relay disconnected; retrying');
    }

    if (!signal.aborted) {
      await sleep(backoffTime, signal);
      backoffTime = Math.min(backoffTime * 2, maxReconnectDelay);
    }
  }
}

async function streamOnce({
  websocketUrl,
  audioSink,
  chatSink,
  signal,
}: {
  websocketUrl: string;
  audioSink: (payload: Buffer) => void;
  chatSink?: (payload: string) => void;
  signal: AbortSignal;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(websocketUrl);
    const abort = () => {
      ws.close();
      resolve();
    };
    signal.addEventListener('abort', abort, { once: true });

    ws.on('open', () => logger.debug('connected to meeting relay'));
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        audioSink(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      } else if (chatSink) {
        chatSink(data.toString());
      }
    });
    ws.on('error', (error: Error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    ws.on('close', () => {
      signal.removeEventListener('abort', abort);
      resolve();
    });
  });
}

async function sleep(duration: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, duration);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
