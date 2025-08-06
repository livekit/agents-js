// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as types from '@google/genai';
import {
  type AudioTranscriptionConfig,
  type ContextWindowCompressionConfig,
  GoogleGenAI,
  type HttpOptions,
  Modality,
  type RealtimeInputConfig,
} from '@google/genai';
import type { APIConnectOptions, stream } from '@livekit/agents';
import {
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  Event,
  Future,
  Queue,
  llm,
  log,
} from '@livekit/agents';
import { Mutex } from '@livekit/mutex';
import type { AudioFrame, VideoFrame } from '@livekit/rtc-node';
import { AudioResampler } from '@livekit/rtc-node';
import { type LLMTool } from '../../tools.js';
import { convertJSONSchemaToOpenAPISchema } from '../../utils.js';
import type { LiveAPIModels, Voice } from './api_proto.js';
import * as api_proto from './api_proto.js';

// Audio constants
const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;

/**
 * Default image encoding options for Google Realtime API
 */
export const DEFAULT_IMAGE_ENCODE_OPTIONS = {
  format: 'JPEG' as const,
  quality: 75,
  resizeOptions: {
    width: 1024,
    height: 1024,
    strategy: 'scale_aspect_fit' as const,
  },
};

/**
 * Input transcription result
 */
export interface InputTranscription {
  itemId: string;
  transcript: string;
}

/**
 * Helper function to check if two sets are equal
 */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * Internal realtime options for Google Realtime API
 */
interface RealtimeOptions {
  model: LiveAPIModels | string;
  apiKey?: string;
  voice: Voice | string;
  language?: string;
  responseModalities: Modality[];
  vertexai: boolean;
  project?: string;
  location?: string;
  candidateCount: number;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  instructions?: string;
  inputAudioTranscription?: AudioTranscriptionConfig;
  outputAudioTranscription?: AudioTranscriptionConfig;
  imageEncodeOptions?: typeof DEFAULT_IMAGE_ENCODE_OPTIONS;
  connOptions: APIConnectOptions;
  httpOptions?: HttpOptions;
  enableAffectiveDialog?: boolean;
  proactivity?: boolean;
  realtimeInputConfig?: RealtimeInputConfig;
  contextWindowCompression?: ContextWindowCompressionConfig;
  apiVersion?: string;
  geminiTools?: LLMTool[];
}

/**
 * Response generation tracking
 */
interface ResponseGeneration {
  messageChannel: stream.StreamChannel<llm.MessageGeneration>;
  functionChannel: stream.StreamChannel<llm.FunctionCall>;

  inputId: string;
  responseId: string;
  textChannel: stream.StreamChannel<string>;
  audioChannel: stream.StreamChannel<AudioFrame>;

  inputTranscription: string;
  outputText: string;

  /** @internal */
  _createdTimestamp: number;
  /** @internal */
  _firstTokenTimestamp?: number;
  /** @internal */
  _completedTimestamp?: number;
  /** @internal */
  _done: boolean;
}

/**
 * Google Realtime Model for real-time voice conversations with Gemini models
 */
export class RealtimeModel extends llm.RealtimeModel {
  /** @internal */
  _options: RealtimeOptions;

  constructor(
    options: {
      /**
       * Initial system instructions for the model
       */
      instructions?: string;

      /**
       * The name of the model to use
       * @default "gemini-2.0-flash-live-001" (Gemini API) or "gemini-2.0-flash-exp" (VertexAI)
       */
      model?: LiveAPIModels | string;

      /**
       * Google Gemini API key. If not provided, will attempt to read from GOOGLE_API_KEY environment variable
       */
      apiKey?: string;

      /**
       * Voice setting for audio outputs
       * @default "Puck"
       */
      voice?: Voice | string;

      /**
       * The language (BCP-47 Code) to use for the API
       * See https://ai.google.dev/gemini-api/docs/live#supported-languages
       */
      language?: string;

      /**
       * Modalities to use, such as [Modality.TEXT, Modality.AUDIO]
       * @default [Modality.AUDIO]
       */
      modalities?: Modality[];

      /**
       * Whether to use VertexAI for the API
       * @default false
       */
      vertexai?: boolean;

      /**
       * The project ID to use for the API (for VertexAI)
       */
      project?: string;

      /**
       * The location to use for the API (for VertexAI)
       * @default "us-central1"
       */
      location?: string;

      /**
       * The number of candidate responses to generate
       * @default 1
       */
      candidateCount?: number;

      /**
       * Sampling temperature for response generation
       * @default 0.8
       */
      temperature?: number;

      /**
       * Maximum number of tokens in the response
       */
      maxOutputTokens?: number;

      /**
       * The top-p value for response generation
       */
      topP?: number;

      /**
       * The top-k value for response generation
       */
      topK?: number;

      /**
       * The presence penalty for response generation
       */
      presencePenalty?: number;

      /**
       * The frequency penalty for response generation
       */
      frequencyPenalty?: number;

      /**
       * The configuration for input audio transcription
       */
      inputAudioTranscription?: AudioTranscriptionConfig;

      /**
       * The configuration for output audio transcription
       */
      outputAudioTranscription?: AudioTranscriptionConfig;

      /**
       * The configuration for image encoding
       */
      imageEncodeOptions?: typeof DEFAULT_IMAGE_ENCODE_OPTIONS;

      /**
       * Whether to enable affective dialog
       * @default false
       */
      enableAffectiveDialog?: boolean;

      /**
       * Whether to enable proactive audio
       * @default false
       */
      proactivity?: boolean;

      /**
       * The configuration for realtime input
       */
      realtimeInputConfig?: RealtimeInputConfig;

      /**
       * The configuration for context window compression
       */
      contextWindowCompression?: ContextWindowCompressionConfig;

      /**
       * API version to use
       */
      apiVersion?: string;

      /**
       * The configuration for the API connection
       * @default DEFAULT_API_CONNECT_OPTIONS
       */
      connOptions?: APIConnectOptions;

      /**
       * HTTP options for API requests
       */
      httpOptions?: HttpOptions;

      /**
       * Gemini-specific tools to use for the session
       */
      geminiTools?: LLMTool[];
    } = {},
  ) {
    super({
      messageTruncation: false,
      turnDetection: false,
      userTranscription: options.inputAudioTranscription !== undefined,
      autoToolReplyGeneration: false,
    });

    // Environment variable fallbacks
    const apiKey = options.apiKey || process.env.GOOGLE_API_KEY;
    const project = options.project || process.env.GOOGLE_CLOUD_PROJECT;
    const location = options.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    const vertexai = options.vertexai ?? false;

    // Model selection based on API type
    const defaultModel = vertexai ? 'gemini-2.0-flash-exp' : 'gemini-2.0-flash-live-001';

    this._options = {
      model: options.model || defaultModel,
      apiKey,
      voice: options.voice || 'Puck',
      language: options.language,
      responseModalities: options.modalities || [Modality.AUDIO],
      vertexai,
      project,
      location,
      candidateCount: options.candidateCount || 1,
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      topP: options.topP,
      topK: options.topK,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      instructions: options.instructions,
      inputAudioTranscription: options.inputAudioTranscription,
      outputAudioTranscription: options.outputAudioTranscription,
      imageEncodeOptions: options.imageEncodeOptions || DEFAULT_IMAGE_ENCODE_OPTIONS,
      connOptions: options.connOptions || DEFAULT_API_CONNECT_OPTIONS,
      httpOptions: options.httpOptions,
      enableAffectiveDialog: options.enableAffectiveDialog,
      proactivity: options.proactivity,
      realtimeInputConfig: options.realtimeInputConfig,
      contextWindowCompression: options.contextWindowCompression,
      apiVersion: options.apiVersion,
      geminiTools: options.geminiTools,
    };
  }

  /**
   * Create a new realtime session
   */
  session() {
    return new RealtimeSession(this);
  }

  /**
   * Update model options
   */
  updateOptions(options: { voice?: Voice | string; temperature?: number }): void {
    if (options.voice !== undefined) {
      this._options.voice = options.voice;
    }
    if (options.temperature !== undefined) {
      this._options.temperature = options.temperature;
    }

    // TODO: Notify active sessions of option changes
  }

  /**
   * Close the model and cleanup resources
   */
  async close(): Promise<void> {
    // TODO: Implementation depends on session management
  }
}

/**
 * Google Realtime Session for real-time voice conversations
 *
 * This session provides real-time streaming capabilities with Google's Gemini models,
 * supporting both text and audio modalities with function calling capabilities.
 */
export class RealtimeSession extends llm.RealtimeSession {
  private _tools: llm.ToolContext = {};
  private _geminiDeclarations: types.FunctionDeclaration[] = [];
  private _chatCtx = llm.ChatContext.empty();
  private _messageChannel = new Queue<api_proto.ClientEvents>();
  private _inputResampler?: AudioResampler;
  private _instructions?: string;
  private _realtimeModel: RealtimeModel;
  private _currentGeneration?: ResponseGeneration;

  // Google-specific properties
  private _client?: GoogleGenAI;
  private _activeSession?: types.Session;
  private _sessionShouldClose = new Event();
  private _responseCreatedFutures: { [id: string]: Future<llm.GenerationCreatedEvent> } = {};
  private _pendingGenerationFut?: Future<llm.GenerationCreatedEvent>;
  private _sessionResumptionHandle?: string;
  private _inUserActivity = false;
  private _sessionLock = new Mutex();
  private _numRetries = 0;

  // Audio handling
  private _bstream: AudioByteStream;

  #logger = log();
  #closed = false;

  constructor(realtimeModel: RealtimeModel) {
    super(realtimeModel as any); // Type assertion to work around inheritance issues

    this._realtimeModel = realtimeModel;
    this._bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS, SAMPLE_RATE / 10);

    this._initializeClient();
  }

  private _initializeClient(): void {
    if (this._realtimeModel._options.vertexai) {
      // TODO: Initialize VertexAI client
      if (!this._realtimeModel._options.project) {
        throw new Error('Project is required for VertexAI');
      }
      // this._client = new VertexAI({ project: this._realtimeModel._options.project });
    } else {
      if (!this._realtimeModel._options.apiKey) {
        throw new Error(
          'Google API key is required, either using the argument or by setting the GOOGLE_API_KEY environmental variable',
        );
      }
      this._client = new GoogleGenAI(this._realtimeModel._options.apiKey);
    }
  }

  private async _closeActiveSession(): Promise<void> {
    if (this._activeSession) {
      try {
        await this._activeSession.close();
      } catch (error) {
        this.#logger.warn({ error }, 'Error closing active session');
      } finally {
        this._activeSession = undefined;
      }
    }
  }

  private _markRestartNeeded(): void {
    this.#logger.debug('Marking session restart as needed');
    this._sessionShouldClose.set();
  }

  get chatCtx(): llm.ChatContext {
    return this._chatCtx.copy();
  }

  get tools(): llm.ToolContext {
    return { ...this._tools };
  }

  get _manualActivityDetection(): boolean {
    return true; // Google Realtime API requires manual activity detection
  }

  async updateInstructions(instructions: string): Promise<void> {
    this._instructions = instructions;
    this._markRestartNeeded();
  }

  async updateChatCtx(chatCtx: llm.ChatContext): Promise<void> {
    // Simple diff to check if context has changed significantly
    const hasChanges =
      this._chatCtx.items.length !== chatCtx.items.length ||
      this._chatCtx.items.some((item, i) => item.id !== chatCtx.items[i]?.id);

    if (!hasChanges) {
      return;
    }

    const diffOps = llm.computeChatCtxDiff(this._chatCtx, chatCtx);

    if (diffOps.toRemove.length > 0) {
      this.#logger.warn('Gemini Live does not support removing messages');
    }

    // For Google Realtime, we typically restart the session with new context
    if (diffOps.toCreate.length > 0) {
      this._chatCtx = chatCtx.copy();

      // Convert to Google's format
      const turns = this._chatCtx
        .copy({
          excludeEmptyMessage: true,
          excludeFunctionCall: true,
        })
        .toProviderFormat('google');

      const content: types.LiveClientContent = {
        turns: turns.map((turn: any) => turn),
        turnComplete: false,
      };

      this._sendClientEvent(content);
    }
  }

  async updateTools(tools: llm.ToolContext): Promise<void> {
    const newDeclarations: types.FunctionDeclaration[] = [];

    for (const [name, tool] of Object.entries(tools)) {
      if (!llm.isFunctionTool(tool)) {
        this.#logger.warn({ name }, 'Skipping non-function tool for Google Realtime API');
        continue;
      }

      try {
        const jsonSchema = llm.toJsonSchema(tool.parameters);
        const openApiSchema = convertJSONSchemaToOpenAPISchema(jsonSchema);

        newDeclarations.push({
          name,
          description: tool.description,
          parameters: openApiSchema,
        });
      } catch (error) {
        this.#logger.error({ name, error }, 'Failed to convert tool to Google format');
      }
    }

    const currentToolNames = new Set(this._geminiDeclarations.map((f) => f.name));
    const newToolNames = new Set(newDeclarations.map((f) => f.name));

    if (!setsEqual(currentToolNames, newToolNames)) {
      this._geminiDeclarations = newDeclarations;
      this._tools = tools;
      this._markRestartNeeded();
    }
  }

  updateOptions(options: {
    toolChoice?: llm.ToolChoice;
    voice?: Voice | string;
    temperature?: number;
  }): void {
    let hasChanges = false;

    if (options.voice !== undefined) {
      this._realtimeModel._options.voice = options.voice;
      hasChanges = true;
    }
    if (options.temperature !== undefined) {
      this._realtimeModel._options.temperature = options.temperature;
      hasChanges = true;
    }

    if (hasChanges) {
      this._markRestartNeeded();
    }
  }

  pushAudio(frame: AudioFrame): void {
    for (const f of this._resampleAudio(frame)) {
      for (const nf of this._bstream.write(f.data.buffer)) {
        const realtimeInput: types.LiveClientRealtimeInput = {
          mediaChunks: [
            { data: Buffer.from(nf.data.buffer).toString('base64'), mimeType: 'audio/pcm' },
          ],
        };
        this._sendClientEvent(realtimeInput);
      }
    }
  }

  pushVideo(frame: VideoFrame): void {
    // Google Realtime API doesn't support video input yet
    this.#logger.warn('Video input is not supported by Google Realtime API');
  }

  private _sendClientEvent(event: api_proto.ClientEvents): void {
    if (this.#closed) {
      return;
    }
    this._messageChannel.put(event);
  }

  async generateReply(instructions?: string): Promise<llm.GenerationCreatedEvent> {
    if (this._pendingGenerationFut && !this._pendingGenerationFut.done) {
      this.#logger.warn(
        'generate_reply called while another generation is pending, cancelling previous.',
      );
      // Since Future doesn't have cancel, we just create a new one
      this._pendingGenerationFut = undefined;
    }

    const fut = new Future<llm.GenerationCreatedEvent>();
    this._pendingGenerationFut = fut;

    try {
      if (instructions) {
        await this.updateInstructions(instructions);
      }

      // Start generation
      this._startNewGeneration();

      return await fut.await;
    } catch (error) {
      this._pendingGenerationFut = undefined;
      throw error;
    }
  }

  startUserActivity(): void {
    if (this._inUserActivity) {
      return;
    }
    this._inUserActivity = true;
    this.emit('input_speech_started', {} as llm.InputSpeechStartedEvent);
  }

  async interrupt() {
    // For Google Realtime API, we use start_user_activity to interrupt
    this.startUserActivity();
  }

  async truncate(_options: { messageId: string; audioEndMs: number; audioTranscript?: string }) {
    // Google Realtime API doesn't support truncation
    this.#logger.warn('Truncation is not supported by Google Realtime API');
  }

  async commitAudio() {
    // Google Realtime API auto-commits audio
  }

  async clearAudio() {
    // Clear the audio buffer
    this._bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS, SAMPLE_RATE / 10);
  }

  private *_resampleAudio(frame: AudioFrame): Generator<AudioFrame> {
    // For now, just pass through - TODO: implement proper resampling if needed
    yield frame;
  }

  // TODO: Implement the remaining methods from the Python version
  private _startNewGeneration(): void {
    // TODO: Implement generation start logic
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this._closeActiveSession();
    super.close();
  }
}
