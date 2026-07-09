// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { stream, voice } from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { log } from '../log.js';

const HEADER_SIZE = 5;
const DEFAULT_STT_RATE = 16000;
const STT_CHANNELS = 1;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

function deserializeFrame(payload: Buffer): AudioFrame | null {
  if (payload.length < HEADER_SIZE) {
    return null;
  }

  const sampleRate = payload.readUInt32LE(0);
  const channels = payload.readUInt8(4) || 1;
  const pcm = payload.subarray(HEADER_SIZE);
  const samplesPerChannel = Math.floor(pcm.length / 2 / channels);
  if (samplesPerChannel <= 0) {
    return null;
  }

  const frameBytes = samplesPerChannel * channels * 2;
  const aligned = new ArrayBuffer(frameBytes);
  new Uint8Array(aligned).set(pcm.subarray(0, frameBytes));
  const data = new Int16Array(aligned);

  return new AudioFrame(data, sampleRate || DEFAULT_STT_RATE, channels, samplesPerChannel);
}

function downmixToMono(frame: AudioFrame): AudioFrame {
  if (frame.channels === 1) {
    return frame;
  }

  const data = frame.data;
  const mono = new Int16Array(frame.samplesPerChannel);
  for (let i = 0; i < frame.samplesPerChannel; i++) {
    let sum = 0;
    for (let channel = 0; channel < frame.channels; channel++) {
      sum += data[i * frame.channels + channel]!;
    }
    mono[i] = Math.round(sum / frame.channels);
  }

  return new AudioFrame(mono, frame.sampleRate, STT_CHANNELS, frame.samplesPerChannel);
}

/** AudioInput that feeds mixed external meeting audio into AgentSession STT. */
export class MeetingAudioInput extends voice.AudioInput {
  private readonly channel = stream.createStreamChannel<AudioFrame>();
  private readonly rateOut: number;
  private resampler?: AudioResampler;
  private resamplerInRate?: number;
  private closed = false;

  #logger = log();

  constructor({ rateOut = DEFAULT_STT_RATE }: { rateOut?: number } = {}) {
    super();
    this.rateOut = rateOut;
    this.multiStream.addInputStream(this.channel.stream());
  }

  /** Enqueue a serialized PCM frame from the meeting relay WebSocket. */
  submit(payload: Buffer): void {
    if (this.closed) {
      return;
    }

    const frame = deserializeFrame(payload);
    if (frame === null) {
      return;
    }

    for (const out of this.resample(downmixToMono(frame))) {
      void this.channel.write(out).catch((error) => {
        this.#logger.warn({ error }, 'failed to write meeting audio frame');
      });
    }
  }

  override async close(): Promise<void> {
    this.closed = true;
    await this.channel.close();
    await super.close();
  }

  private resample(frame: AudioFrame): AudioFrame[] {
    if (frame.sampleRate === this.rateOut) {
      return [frame];
    }

    if (this.resampler === undefined || this.resamplerInRate !== frame.sampleRate) {
      this.resampler = new AudioResampler(frame.sampleRate, this.rateOut, frame.channels);
      this.resamplerInRate = frame.sampleRate;
    }

    return this.resampler.push(frame);
  }
}

/** Stream meeting audio and chat from the LemonSlice meeting relay. */
export async function streamMeetingRelay(
  websocketUrl: string,
  audioSink: (payload: Buffer) => void,
  {
    stop,
    chatSink,
    reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS,
    maxReconnectDelayMs = MAX_RECONNECT_DELAY_MS,
  }: {
    stop: AbortSignal;
    chatSink?: (payload: string) => void;
    reconnectDelayMs?: number;
    maxReconnectDelayMs?: number;
  },
): Promise<void> {
  const logger = log();
  let backoffMs = reconnectDelayMs;

  while (!stop.aborted) {
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(websocketUrl);

        const cleanup = () => {
          stop.removeEventListener('abort', onAbort);
          ws.removeAllListeners();
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        };

        const onAbort = () => {
          cleanup();
          resolve();
        };

        stop.addEventListener('abort', onAbort);

        ws.on('open', () => {
          backoffMs = reconnectDelayMs;
          logger.debug('connected to meeting relay');
        });

        ws.on('message', (data, isBinary) => {
          if (stop.aborted) {
            return;
          }

          if (isBinary) {
            audioSink(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
            return;
          }

          if (chatSink !== undefined) {
            chatSink(typeof data === 'string' ? data : data.toString());
          }
        });

        ws.on('close', () => {
          cleanup();
          resolve();
        });

        ws.on('error', (error) => {
          cleanup();
          reject(error);
        });
      });
    } catch (error) {
      if (stop.aborted) {
        return;
      }
      logger.warn({ error, backoffMs }, 'meeting relay disconnected; retrying');
    }

    if (stop.aborted) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(backoffMs * 2, maxReconnectDelayMs);
  }
}
