// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { log, tts } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { URL } from 'url';
import { type RawData, WebSocket } from 'ws';
import type { TTSModels } from './models.js';

type Voice = {
  id: string;
  name: string;
  category: string;
  settings?: VoiceSettings;
};

type VoiceSettings = {
  stability: number; // 0..1
  similarity_boost: number; // 0..1
  style?: number; // 0..1
  use_speaker_boost: boolean;
};

const DEFAULT_VOICE: Voice = {
  id: 'EXAVITQu4vr4xnSDxMaL',
  name: 'Bella',
  category: 'premade',
  settings: {
    stability: 0.71,
    similarity_boost: 0.5,
    style: 0.0,
    use_speaker_boost: true,
  },
};

const API_BASE_URL_V1 = 'https://api.elevenlabs.io/v1';
const AUTHORIZATION_HEADER = 'xi-api-key';
const STREAM_EOS = '';

type TTSOptions = {
  apiKey: string;
  voice: Voice;
  modelID: TTSModels;
  baseURL: string;
  sampleRate: number;
  latency: number;
};

export class TTS extends tts.TTS {
  config: TTSOptions;

  constructor(
    voice = DEFAULT_VOICE,
    modelID: TTSModels = 'eleven_multilingual_v2',
    apiKey?: string,
    baseURL?: string,
    sampleRate = 24000,
    latency = 2,
  ) {
    super(true);
    apiKey = apiKey || process.env.ELEVEN_API_KEY;
    if (apiKey === undefined) {
      throw new Error(
        'ElevenLabs API key is required, whether as an argument or as $ELEVEN_API_KEY',
      );
    }

    this.config = {
      voice,
      modelID,
      apiKey,
      baseURL: baseURL || API_BASE_URL_V1,
      sampleRate,
      latency,
    };
  }

  async listVoices(): Promise<Voice[]> {
    return fetch(this.config.baseURL + '/voices', {
      headers: {
        [AUTHORIZATION_HEADER]: this.config.apiKey,
      },
    })
      .then((data) => data.json())
      .then((data) => {
        const voices: Voice[] = [];
        for (const voice of (
          data as { voices: { voice_id: string; name: string; category: string }[] }
        ).voices) {
          voices.push({
            id: voice.voice_id,
            name: voice.name,
            category: voice.category,
            settings: undefined,
          });
        }
        return voices;
      });
  }

  async synthesize(text: string): Promise<tts.ChunkedStream> {
    return new ChunkedStream(text, this.config);
  }

  stream(): tts.SynthesizeStream {
    return new SynthesizeStream(this.config);
  }
}

export class SynthesizeStream extends tts.SynthesizeStream {
  closed: boolean;
  config: TTSOptions;
  text: string;
  task: {
    run: Promise<void>;
    cancel: () => void;
  };
  queue: string[] = [];
  eventQueue: (tts.SynthesisEvent | undefined)[] = [];

  constructor(config: TTSOptions) {
    super();
    this.config = config;
    this.closed = false;
    this.text = '';
    this.task = {
      run: new Promise(() => {
        this.run(32);
      }),
      cancel: () => {},
    };
  }

  get streamURL(): string {
    return `${this.config.baseURL}/text-to-speech/${this.config.voice.id}/stream-input?model_id=${this.config.modelID}&optimize_streaming_latency=${this.config.latency}`;
  }

  pushText(token?: string | undefined): void {
    if (this.closed) throw new Error('cannot push to a closed stream');
    if (!token || token.length === 0) return;

    const splitters = '.,?!;:—-()[]} ';
    this.text += token;
    if (splitters.includes(token[token.length - 1])) {
      this.queue.push(this.text);
      this.text = '';
    }
  }

  async run(maxRetry: number) {
    let retries = 0;
    while (!this.closed) {
      const url = new URL(this.streamURL);
      url.protocol = url.protocol.replace('http', 'ws');
      const ws = new WebSocket(url, {
        headers: { [AUTHORIZATION_HEADER]: this.config.apiKey },
      });

      try {
        await new Promise((resolve, reject) => {
          ws.on('open', resolve);
          ws.on('error', (error) => reject(error));
          ws.on('close', (code) => reject(`WebSocket returned ${code}`));
        });

        ws.send(JSON.stringify({ text: ' ', voice_settings: this.config.voice }));
        let started = false;
        const retryQueue: string[] = [];
        const task = this.listenTask(ws);
        while (ws.readyState !== ws.CLOSED) {
          let text = undefined;
          if (retryQueue.length === 0) {
            text = this.queue.shift();
          } else {
            text = retryQueue.shift();
          }

          if (!started) {
            this.eventQueue.push(new tts.SynthesisEvent(tts.SynthesisEventType.STARTED));
            started = true;
          }

          try {
            ws.send(JSON.stringify({ text, try_trigger_generation: true }));
          } catch (e) {
            // XI closes idle connections after a while.
            retryQueue.push(text!);
            break;
          }

          if (text == STREAM_EOS) {
            await task;
            this.eventQueue.push(new tts.SynthesisEvent(tts.SynthesisEventType.FINISHED));
            break;
          }
        }
      } catch (e) {
        if (retries >= maxRetry) {
          throw new Error(`failed to connect to ElevenLabs after ${retries} attempts: ${e}`);
        }

        const delay = Math.min(retries * 5, 5);
        retries++;

        log().warn(
          `failed to connect to ElevenLabs, retrying in ${delay} seconds: ${e} (${retries}/${maxRetry})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
    }
    this.closed = true;
  }

  async listenTask(ws: WebSocket) {
    while (!this.closed) {
      try {
        await new Promise<RawData>((resolve, reject) => {
          ws.on('message', (data) => resolve(data));
          ws.on('close', (code, reason) => reject(`WebSocket closed with code ${code}: ${reason}`));
        }).then((msg) => {
          const json = JSON.parse(msg.toString());
          if ('audio' in json) {
            const data = new Int16Array(Buffer.from(json.audio, 'base64'));
            const audioFrame = new AudioFrame(
              data,
              this.config.sampleRate,
              1,
              Math.trunc(data.length / 2),
            );
            this.eventQueue.push(
              new tts.SynthesisEvent(tts.SynthesisEventType.AUDIO, { text: '', data: audioFrame }),
            );
          }
        });
      } catch {
        break;
      }
    }
  }

  flush() {
    this.queue.push(this.text + ' ');
    this.text = '';
    this.queue.push('');
  }

  next(): IteratorResult<tts.SynthesisEvent> {
    const event = this.eventQueue.shift();
    if (event) {
      return { done: false, value: event };
    } else {
      return { done: true, value: undefined };
    }
  }

  async close(wait: boolean) {
    if (wait) {
      log().warn('wait is not yet supported for ElevenLabs TTS');
    }

    try {
      await this.task.run;
    } finally {
      this.eventQueue.push(undefined);
    }
  }
}

class ChunkedStream extends tts.ChunkedStream {
  config: TTSOptions;
  text: string;
  queue: (tts.SynthesizedAudio | undefined)[] = [];

  constructor(text: string, config: TTSOptions) {
    super();
    this.config = config;
    this.text = text;
  }

  async next(): Promise<IteratorResult<tts.SynthesizedAudio>> {
    await this.run();
    const audio = this.queue.shift();
    if (audio) {
      return { done: false, value: audio };
    } else {
      return { done: true, value: undefined };
    }
  }

  async close() {
    this.queue.push(undefined);
  }

  async run() {
    const voice = this.config.voice;

    const url = new URL(`${this.config.baseURL}/text-to-speech/${voice.id}/stream`);
    url.searchParams.append('output_format', 'pcm_' + this.config.sampleRate);
    url.searchParams.append('optimize_streaming_latency', this.config.latency.toString());

    await fetch(url.toString(), {
      method: 'POST',
      headers: {
        [AUTHORIZATION_HEADER]: this.config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: this.text,
        model_id: this.config.modelID,
        voice_settings: this.config.voice.settings || undefined,
      }),
    })
      .then((data) => data.arrayBuffer())
      .then((data) => new DataView(data, 0, data.byteLength))
      .then((data) =>
        this.queue.push(
          {
            text: this.text,
            data: new AudioFrame(
              new Int16Array(data.buffer),
              this.config.sampleRate,
              1,
              data.byteLength / 2,
            ),
          },
          undefined,
        ),
      )
      .catch(() => this.queue.push(undefined));
  }
}
