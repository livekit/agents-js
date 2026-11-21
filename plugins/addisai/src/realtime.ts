// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectionError, APIStatusError, AudioByteStream, llm } from '@livekit/agents';
import { type AudioFrame, AudioResampler } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import type WebSocket from 'ws';
import { isRecord } from './utils.js';
import { JsonMessageQueue, connectWebSocket } from './websocket.js';

const REALTIME_URL = 'wss://relay.addisassistant.com/ws';
const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000;

/** Options for AddisAI's conversational realtime audio model. @public */
export interface RealtimeModelOptions {
  apiKey?: string;
  url: string;
  connectionTimeoutMs: number;
}

const DEFAULT_OPTIONS: Pick<RealtimeModelOptions, 'url' | 'connectionTimeoutMs'> = {
  url: REALTIME_URL,
  connectionTimeoutMs: 10_000,
};

/** AddisAI's interruption-capable, full-duplex conversational model. @public */
export class RealtimeModel extends llm.DuplexModel {
  readonly options: RealtimeModelOptions & { apiKey: string };
  #sessions = new Set<RealtimeSession>();

  constructor(options: Partial<RealtimeModelOptions> = {}) {
    super({ userTranscription: false, autoToolReplyGeneration: false });
    const apiKey = options.apiKey ?? process.env.ADDIS_API_KEY;
    if (!apiKey) {
      throw new Error('AddisAI API key is required, either as apiKey or via ADDIS_API_KEY');
    }
    const url = options.url ?? DEFAULT_OPTIONS.url;
    validateRealtimeURL(url);
    this.options = {
      apiKey,
      url,
      connectionTimeoutMs: options.connectionTimeoutMs ?? DEFAULT_OPTIONS.connectionTimeoutMs,
    };
  }

  get model(): string {
    return 'አሌፍ-1.2-realtime-audio';
  }

  get provider(): string {
    return 'AddisAI';
  }

  override label(): string {
    return 'addisai.RealtimeModel';
  }

  session(): RealtimeSession {
    const session = new RealtimeSession(this, () => this.#sessions.delete(session));
    this.#sessions.add(session);
    return session;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#sessions].map((session) => session.close()));
    this.#sessions.clear();
  }
}

/** One AddisAI conversational realtime session. @public */
export class RealtimeSession extends llm.DuplexSession {
  #tools = llm.ToolContext.empty();
  #socket?: WebSocket;
  #messages?: JsonMessageQueue;
  #ready = false;
  #pending: AudioFrame[] = [];
  #resampler?: AudioResampler;
  #resamplerInputRate?: number;
  #controller!: ReadableStreamDefaultController<llm.DuplexAudioFrame>;
  #audioStream: ReadableStream<llm.DuplexAudioFrame>;
  #output = new AudioByteStream(OUTPUT_RATE, 1, OUTPUT_RATE / 10);
  #onClose: () => void;

  constructor(
    private modelInstance: RealtimeModel,
    onClose: () => void,
  ) {
    super(modelInstance);
    this.#onClose = onClose;
    this.#audioStream = new ReadableStream({
      start: (controller) => {
        this.#controller = controller;
      },
    });
    void this.run();
  }

  get audioStream(): ReadableStream<llm.DuplexAudioFrame> {
    return this.#audioStream;
  }

  get tools(): llm.ToolContext {
    return this.#tools.copy();
  }

  pushAudio(frame: AudioFrame): void {
    if (this._closing) return;
    if (this.#resampler && frame.sampleRate !== this.#resamplerInputRate) {
      this.#resampler.close();
      this.#resampler = undefined;
    }
    if (!this.#resampler && (frame.sampleRate !== INPUT_RATE || frame.channels !== 1)) {
      this.#resampler = new AudioResampler(frame.sampleRate, INPUT_RATE, 1);
      this.#resamplerInputRate = frame.sampleRate;
    }
    const frames = this.#resampler ? this.#resampler.push(frame) : [frame];
    for (const output of frames) {
      if (this.#ready) this.sendFrame(output);
      else this.#pending.push(output);
    }
  }

  protected async closeConnection(): Promise<void> {
    this.#messages?.close();
    this.#socket?.close();
    this.#resampler?.close();
    try {
      this.#controller.close();
    } catch {
      // The controller is already errored or closed.
    }
    this.#onClose();
  }

  async _updateInstructions(_instructions: string): Promise<void> {}

  async _appendItems(_items: llm.ChatItem[]): Promise<void> {}

  async _updateTools(tools: llm.ToolContext): Promise<void> {
    this.#tools = tools.copy();
    if (tools.flatten().length) throw new llm.RealtimeError('AddisAI realtime has no tool calls');
  }

  _updateOptions(options: { toolChoice?: llm.ToolChoice | null }): void {
    if (options.toolChoice !== undefined && options.toolChoice !== null) {
      throw new llm.RealtimeError('AddisAI realtime has no tool choice');
    }
  }

  private async run(): Promise<void> {
    try {
      await this._configured.wait();
      if (this._closing) return;
      const url = new URL(this.modelInstance.options.url);
      url.searchParams.set('apiKey', this.modelInstance.options.apiKey);
      const started = performance.now();
      this.#socket = await connectWebSocket(url, this.modelInstance.options.connectionTimeoutMs);
      this._reportConnectionAcquired(performance.now() - started);
      this.#messages = new JsonMessageQueue(this.#socket);
      while (!this._closing) {
        const event = await this.#messages.next();
        if (
          event.setupComplete === true ||
          (event.type === 'status' && /ready/i.test(String(event.message ?? '')))
        ) {
          this.#ready = true;
          for (const frame of this.#pending.splice(0)) this.sendFrame(frame);
          continue;
        }
        if (isRecord(event.error)) {
          throw new APIStatusError({
            message: String(event.error.message ?? 'AddisAI realtime returned an error'),
            options: { statusCode: Number(event.error.status ?? 500), body: event },
          });
        }
        const content = isRecord(event.serverContent) ? event.serverContent : undefined;
        const turn = content && isRecord(content.modelTurn) ? content.modelTurn : undefined;
        if (turn && Array.isArray(turn.parts)) {
          for (const part of turn.parts) {
            const inline =
              isRecord(part) && isRecord(part.inlineData) ? part.inlineData : undefined;
            if (!inline || typeof inline.data !== 'string') continue;
            for (const frame of this.#output.write(Buffer.from(inline.data, 'base64'))) {
              this.#controller.enqueue({ frame });
            }
          }
        }
        if (content?.turnComplete === true) {
          for (const frame of this.#output.flush()) this.#controller.enqueue({ frame });
        }
      }
    } catch (error) {
      if (!this._closing) {
        const resolved =
          error instanceof Error
            ? error
            : new APIConnectionError({
                message: String(error),
                options: { retryable: false },
              });
        this.emit('error', {
          type: 'realtime_model_error',
          timestamp: Date.now(),
          label: this.modelInstance.label(),
          error: resolved,
          recoverable: false,
        });
        this.#controller.error(resolved);
      }
    } finally {
      if (!this._closing) this.#onClose();
    }
  }

  private sendFrame(frame: AudioFrame): void {
    this.#socket?.send(
      JSON.stringify({
        data: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength).toString(
          'base64',
        ),
        mimeType: 'audio/pcm;rate=16000',
      }),
    );
  }
}

function validateRealtimeURL(value: string): void {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'wss:' && !(local && url.protocol === 'ws:'))
  ) {
    throw new Error('url must be a secure WebSocket URL without credentials or query parameters');
  }
}
