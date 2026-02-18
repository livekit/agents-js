// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import {
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  log,
  shortuuid,
  stream,
} from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type { Phonic } from 'phonic';
import { PhonicClient } from 'phonic';
import type { ServerEvent, Voice } from './api_proto.js';

const PHONIC_INPUT_SAMPLE_RATE = 44100;
const PHONIC_OUTPUT_SAMPLE_RATE = 44100;
const PHONIC_NUM_CHANNELS = 1;
const PHONIC_INPUT_FRAME_MS = 20;
const DEFAULT_MODEL = 'merritt';
const WS_CLOSE_NORMAL = 1000;

export interface RealtimeModelOptions {
  apiKey: string;
  model: string;
  voice?: Voice | string;
  instructions?: string;
  welcomeMessage?: string;
  project?: string;
  connOptions: APIConnectOptions;
  baseUrl?: string;
}

export class RealtimeModel extends llm.RealtimeModel {
  /** @internal */
  _options: RealtimeModelOptions;

  get model(): string {
    return this._options.model;
  }

  constructor(
    options: {
      /**
       * System instructions for the model
       */
      instructions?: string;
      /**
       * Phonic API key. If not provided, will attempt to read from PHONIC_API_KEY environment variable
       */
      apiKey?: string;
      /**
       * The name of the model to use. Defaults to 'merritt'
       */
      model?: Phonic.ConfigPayload['model'] | string;
      /**
       * Voice ID for agent outputs
       */
      voice?: Voice;
      /**
       * Welcome message for the agent to say when the conversation starts
       */
      welcomeMessage?: string;
      /**
       * Project name to use for the conversation. Defaults to `main`
       */
      project?: string;
      /**
       * Connection options for the API connection
       */
      connOptions?: APIConnectOptions;
      baseUrl?: string;
    } = {},
  ) {
    super({
      messageTruncation: false,
      turnDetection: true,
      userTranscription: true,
      // TODO @Phonic-Co: Implement tool support
      // Phonic has automatic tool reply generation, but tools are not supported with Livekit Agents yet.
      autoToolReplyGeneration: true,
      audioOutput: true,
    });

    const apiKey = options.apiKey || process.env.PHONIC_API_KEY;
    if (!apiKey) {
      throw new Error('Phonic API key is required. Provide apiKey or set PHONIC_API_KEY.');
    }

    this._options = {
      apiKey,
      voice: options.voice,
      instructions: options.instructions,
      project: options.project,
      connOptions: options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      model: options.model ?? DEFAULT_MODEL,
      baseUrl: options.baseUrl,
    };
  }

  /**
   * Create a new realtime session
   */
  session(): RealtimeSession {
    return new RealtimeSession(this);
  }

  async close(): Promise<void> {}
}

interface GenerationState {
  responseId: string;
  messageChannel: stream.StreamChannel<llm.MessageGeneration>;
  functionChannel: stream.StreamChannel<llm.FunctionCall>;
  textChannel: stream.StreamChannel<string>;
  audioChannel: stream.StreamChannel<AudioFrame>;
  outputText: string;
}

/**
 * Realtime session for Phonic (https://docs.phonic.co/)
 */
export class RealtimeSession extends llm.RealtimeSession {
  private _tools: llm.ToolContext = {};
  private _chatCtx = llm.ChatContext.empty();

  private options: RealtimeModelOptions;
  private bstream: AudioByteStream;
  private inputResampler?: AudioResampler;
  private inputResamplerInputRate?: number;

  private currentGeneration?: GenerationState;

  #client: PhonicClient;
  #socket?: Awaited<ReturnType<PhonicClient['conversations']['connect']>>;
  #logger = log();
  #closed = false;
  #connectTask: Promise<void>;

  constructor(realtimeModel: RealtimeModel) {
    super(realtimeModel);
    this.options = realtimeModel._options;
    this.#client = new PhonicClient({
      apiKey: this.options.apiKey,
      baseUrl: this.options.baseUrl,
    });
    this.bstream = new AudioByteStream(
      PHONIC_INPUT_SAMPLE_RATE,
      PHONIC_NUM_CHANNELS,
      (PHONIC_INPUT_SAMPLE_RATE * PHONIC_INPUT_FRAME_MS) / 1000,
    );
    this.#connectTask = this.connect().catch((error: unknown) => {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.emitError(normalizedError, false);
    });
  }

  get chatCtx(): llm.ChatContext {
    return this._chatCtx.copy();
  }

  get tools(): llm.ToolContext {
    return { ...this._tools };
  }

  async updateInstructions(_instructions: string): Promise<void> {
    this.#logger.error(`updateInstructions is not supported by the Phonic realtime model.`);
  }

  async updateChatCtx(chatCtx: llm.ChatContext): Promise<void> {
    this._chatCtx = chatCtx.copy();
  }

  async updateTools(tools: llm.ToolContext): Promise<void> {
    this._tools = { ...tools };
    this.#logger.error(`Tool use is not supported by the Phonic realtime model.`);
  }

  updateOptions(_options: { toolChoice?: llm.ToolChoice | null }): void {
    this.#logger.error(`updateOptions is not supported by the Phonic realtime model.`);
  }

  pushAudio(frame: AudioFrame): void {
    if (this.#closed) {
      return;
    }

    for (const resampledFrame of this.resampleAudio(frame)) {
      for (const chunk of this.bstream.write(resampledFrame.data.buffer as ArrayBuffer)) {
        const bytes = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
        const payload: Phonic.AudioChunkPayload = {
          type: 'audio_chunk',
          audio: bytes.toString('base64'),
        };

        if (!this.#socket) {
          continue;
        }
        this.#socket.sendAudioChunk(payload);
      }
    }
  }

  async generateReply(_instructions?: string): Promise<llm.GenerationCreatedEvent> {
    throw new Error('generateReply is not supported by the Phonic realtime model.');
  }

  async commitAudio(): Promise<void> {}
  async clearAudio(): Promise<void> {}

  async interrupt(): Promise<void> {
    this.closeCurrentGeneration();
  }

  async truncate(_options: { messageId: string; audioEndMs: number; audioTranscript?: string }) {
    this.#logger.warn('truncate is not supported by the Phonic realtime model.');
  }

  async close(): Promise<void> {
    this.closeCurrentGeneration();
    this.#closed = true;
    this.#socket?.close();
    await this.#connectTask;
    await super.close();
  }

  private async connect(): Promise<void> {
    this.#socket = await this.#client.conversations.connect({
      reconnectAttempts: this.options.connOptions.maxRetry,
    });

    this.#socket.on('message', (message: unknown) =>
      this.handleServerMessage(message as ServerEvent),
    );
    this.#socket.on('error', (error: Error) => this.emitError(error, true));
    this.#socket.on('close', (event: { code?: number }) => {
      this.closeCurrentGeneration();
      if (!this.#closed && event.code !== WS_CLOSE_NORMAL) {
        this.emitError(new Error(`Phonic STS socket closed with code ${event.code ?? -1}`), true);
      }
    });

    await this.#socket.waitForOpen();
    this.#socket.sendConfig({
      type: 'config',
      project: this.options.project,
      system_prompt: this.options.instructions,
      voice_id: this.options.voice,
      input_format: 'pcm_44100',
      output_format: 'pcm_44100',
    });
  }

  private handleServerMessage(message: ServerEvent): void {
    if (this.#closed) {
      return;
    }

    switch (message.type) {
      case 'assistant_started_speaking':
        this.startNewAssistantTurn();
        break;
      case 'assistant_finished_speaking':
        this.finishAssistantTurn();
        break;
      case 'audio_chunk':
        this.handleAudioChunk(message);
        break;
      case 'input_text':
        this.handleInputText(message);
        break;
      case 'user_started_speaking':
        this.handleInputSpeechStarted();
        break;
      case 'user_finished_speaking':
        this.handleInputSpeechStopped();
        break;
      case 'error':
        this.emitError(new Error(message.error.message), false);
        break;
      case 'tool_call':
        this.emitError(
          new Error(
            `WebSocket tool calls are not yet supported by the Phonic realtime model with Livekit Agents.`,
          ),
          false,
        );
        break;
      case 'assistant_chose_not_to_respond':
      case 'assistant_ended_conversation':
      case 'ready_to_start_conversation':
      case 'input_cancelled':
      case 'conversation_created':
      case 'tool_call_output_processed':
      case 'tool_call_interrupted':
      case 'dtmf':
      default:
        break;
    }
  }

  private handleAudioChunk(message: Phonic.AudioChunkResponsePayload): void {
    const gen = this.currentGeneration;
    if (!gen) return;

    if (message.text) {
      gen.outputText += message.text;
      gen.textChannel.write(message.text);
    }

    if (message.audio) {
      const bytes = Buffer.from(message.audio, 'base64');
      const sampleCount = Math.floor(bytes.byteLength / Int16Array.BYTES_PER_ELEMENT);
      if (sampleCount > 0) {
        const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount);
        const frame = new AudioFrame(
          new Int16Array(pcm),
          PHONIC_OUTPUT_SAMPLE_RATE,
          PHONIC_NUM_CHANNELS,
          sampleCount / PHONIC_NUM_CHANNELS,
        );
        gen.audioChannel.write(frame);
      }
    }
  }

  private handleInputText(message: Phonic.InputTextPayload): void {
    this.emit('input_audio_transcription_completed', {
      itemId: shortuuid('PI_'),
      transcript: message.text,
      isFinal: true,
    });
  }

  private handleInputSpeechStarted(): void {
    this.emit('input_speech_started', {});
    this.interrupt();
  }

  private handleInputSpeechStopped(): void {
    this.emit('input_speech_stopped', {
      userTranscriptionEnabled: true,
    });
  }

  private startNewAssistantTurn(): void {
    const responseId = shortuuid('PS_');

    const textChannel = stream.createStreamChannel<string>();
    const audioChannel = stream.createStreamChannel<AudioFrame>();
    const functionChannel = stream.createStreamChannel<llm.FunctionCall>();
    const messageChannel = stream.createStreamChannel<llm.MessageGeneration>();

    messageChannel.write({
      messageId: responseId,
      textStream: textChannel.stream(),
      audioStream: audioChannel.stream(),
      modalities: Promise.resolve(['audio']),
    });

    this.currentGeneration = {
      responseId,
      messageChannel,
      functionChannel,
      textChannel,
      audioChannel,
      outputText: '',
    };

    this.emit('generation_created', {
      messageStream: messageChannel.stream(),
      functionStream: functionChannel.stream(),
      userInitiated: false,
      responseId,
    });
  }

  private finishAssistantTurn(): void {
    const gen = this.currentGeneration;
    if (!gen) return;

    if (gen.outputText) {
      this._chatCtx.addMessage({
        role: 'assistant',
        content: gen.outputText,
        id: gen.responseId,
      });
    }

    this.closeCurrentGeneration();
  }

  private closeCurrentGeneration(): void {
    const gen = this.currentGeneration;
    if (!gen) return;

    gen.textChannel.close();
    gen.audioChannel.close();
    gen.functionChannel.close();
    gen.messageChannel.close();
    this.currentGeneration = undefined;
  }

  private emitError(error: Error, recoverable: boolean): void {
    this.emit('error', {
      timestamp: Date.now(),
      label: 'phonic_realtime',
      error,
      recoverable,
    });
  }

  private *resampleAudio(frame: AudioFrame): Generator<AudioFrame> {
    if (this.inputResampler) {
      if (frame.sampleRate !== this.inputResamplerInputRate) {
        this.inputResampler = undefined;
        this.inputResamplerInputRate = undefined;
      }
    }

    if (
      this.inputResampler === undefined &&
      (frame.sampleRate !== PHONIC_INPUT_SAMPLE_RATE || frame.channels !== PHONIC_NUM_CHANNELS)
    ) {
      this.inputResampler = new AudioResampler(
        frame.sampleRate,
        PHONIC_INPUT_SAMPLE_RATE,
        PHONIC_NUM_CHANNELS,
      );
      this.inputResamplerInputRate = frame.sampleRate;
    }

    if (this.inputResampler) {
      for (const resampledFrame of this.inputResampler.push(frame)) {
        yield resampledFrame;
      }
    } else {
      yield frame;
    }
  }
}
