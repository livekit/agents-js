// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as types from '@google/genai';
import {
  ActivityHandling,
  type AudioTranscriptionConfig,
  type ContextWindowCompressionConfig,
  GoogleGenAI,
  type HttpOptions,
  Modality,
  type RealtimeInputConfig,
  Session,
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
import { toFunctionDeclarations } from '../../utils.js';
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
  private _chatCtx = llm.ChatContext.empty();

  private options: RealtimeOptions;
  private geminiDeclarations: types.FunctionDeclaration[] = [];
  private messageChannel = new Queue<api_proto.ClientEvents>();
  private inputResampler?: AudioResampler;
  private instructions?: string;
  private currentGeneration?: ResponseGeneration;
  private bstream: AudioByteStream;

  // Google-specific properties
  private activeSession?: Session;
  private sessionShouldClose = new Event();
  private responseCreatedFutures: { [id: string]: Future<llm.GenerationCreatedEvent> } = {};
  private pendingGenerationFut?: Future<llm.GenerationCreatedEvent>;

  private sessionResumptionHandle?: string;
  private inUserActivity = false;
  private sessionLock = new Mutex();
  private numRetries = 0;

  #client: GoogleGenAI;
  #task: Promise<void>;
  #logger = log();
  #closed = false;

  constructor(realtimeModel: RealtimeModel) {
    super(realtimeModel);

    this.options = realtimeModel._options;
    this.bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS, SAMPLE_RATE / 20); // 50ms chunks

    const { apiKey, project, location, vertexai, enableAffectiveDialog, proactivity } =
      this.options;

    const apiVersion =
      !this.options.apiVersion && (enableAffectiveDialog || proactivity)
        ? 'v1alpha'
        : this.options.apiVersion;

    const httpOptions = {
      ...this.options.httpOptions,
      apiVersion,
      timeout: this.options.connOptions.timeoutMs,
    };

    const clientOptions: types.GoogleGenAIOptions = vertexai
      ? {
          vertexai: true,
          project,
          location,
          httpOptions,
        }
      : {
          apiKey,
          httpOptions,
        };

    this.#client = new GoogleGenAI(clientOptions);
    this.#task = this.#mainTask();
  }

  private async closeActiveSession(): Promise<void> {
    const unlock = await this.sessionLock.lock();

    if (this.activeSession) {
      try {
        await this.activeSession.close();
      } catch (error) {
        this.#logger.warn({ error }, 'Error closing Gemini session');
      } finally {
        this.activeSession = undefined;
      }
    }

    unlock();
  }

  private markRestartNeeded(): void {
    if (!this.sessionShouldClose.isSet) {
      this.sessionShouldClose.set();
      this.messageChannel = new Queue();
    }
  }

  private getToolResultsForRealtime(
    ctx: llm.ChatContext,
    vertexai: boolean,
  ): types.LiveClientToolResponse | undefined {
    const toolResponses: types.FunctionResponse[] = [];

    for (const item of ctx.items) {
      if (item.type === 'function_call_output') {
        const response: types.FunctionResponse = {
          id: item.callId,
          name: item.name,
          response: { output: item.output },
        };

        if (!vertexai) {
          response.id = item.callId;
        }

        toolResponses.push(response);
      }
    }

    return toolResponses.length > 0 ? { functionResponses: toolResponses } : undefined;
  }

  updateOptions(options: {
    voice?: Voice | string;
    temperature?: number;
    toolChoice?: llm.ToolChoice;
  }) {
    let shouldRestart = false;

    if (options.voice !== undefined && this.options.voice !== options.voice) {
      this.options.voice = options.voice;
      shouldRestart = true;
    }

    if (options.temperature !== undefined && this.options.temperature !== options.temperature) {
      this.options.temperature = options.temperature;
      shouldRestart = true;
    }

    if (shouldRestart) {
      this.markRestartNeeded();
    }
  }

  async updateInstructions(instructions: string): Promise<void> {
    if (this.options.instructions === undefined || this.options.instructions !== instructions) {
      this.options.instructions = instructions;
      this.markRestartNeeded();
    }
  }

  async updateChatCtx(chatCtx: llm.ChatContext): Promise<void> {
    const unlock = await this.sessionLock.lock();
    try {
      if (!this.activeSession) {
        this._chatCtx = chatCtx.copy();
        return;
      }
    } finally {
      unlock();
    }

    const diffOps = llm.computeChatCtxDiff(this._chatCtx, chatCtx);

    if (diffOps.toRemove.length > 0) {
      this.#logger.warn('Gemini Live does not support removing messages');
    }

    const appendCtx = llm.ChatContext.empty();
    for (const [, itemId] of diffOps.toCreate) {
      const item = chatCtx.getById(itemId);
      if (item) {
        appendCtx.items.push(item);
      }
    }

    if (appendCtx.items.length > 0) {
      const [turns] = await appendCtx
        .copy({
          excludeFunctionCall: true,
        })
        .toProviderFormat('google', false);

      const toolResults = this.getToolResultsForRealtime(appendCtx, this.options.vertexai);

      if (turns.length > 0) {
        this.sendClientEvent({
          turns: turns as types.Content[],
          turnComplete: false,
        });
      }

      if (toolResults) {
        this.sendClientEvent(toolResults);
      }
    }

    // since we don't have a view of the history on the server side, we'll assume
    // the current state is accurate. this isn't perfect because removals aren't done.
    this._chatCtx = chatCtx.copy();
  }

  async updateTools(tools: llm.ToolContext): Promise<void> {
    const newDeclarations = toFunctionDeclarations(tools);
    const currentToolNames = new Set(this.geminiDeclarations.map((f) => f.name));
    const newToolNames = new Set(newDeclarations.map((f) => f.name));

    if (!setsEqual(currentToolNames, newToolNames)) {
      this.geminiDeclarations = newDeclarations;
      this._tools = tools;
      this.markRestartNeeded();
    }
  }

  get chatCtx(): llm.ChatContext {
    return this._chatCtx.copy();
  }

  get tools(): llm.ToolContext {
    return { ...this._tools };
  }

  get manualActivityDetection(): boolean {
    return this.options.realtimeInputConfig?.automaticActivityDetection?.disabled ?? false;
  }

  pushAudio(frame: AudioFrame): void {
    for (const f of this.resampleAudio(frame)) {
      for (const nf of this.bstream.write(f.data.buffer)) {
        const realtimeInput: types.LiveClientRealtimeInput = {
          mediaChunks: [
            { data: Buffer.from(nf.data.buffer).toString('base64'), mimeType: 'audio/pcm' },
          ],
        };
        this.sendClientEvent(realtimeInput);
      }
    }
  }

  pushVideo(frame: VideoFrame): void {
    // TODO(brian): implement push video frames
  }

  private sendClientEvent(event: api_proto.ClientEvents) {
    this.messageChannel.put(event);
  }

  async generateReply(instructions?: string): Promise<llm.GenerationCreatedEvent> {
    if (this.pendingGenerationFut && !this.pendingGenerationFut.done) {
      this.#logger.warn(
        'generateReply called while another generation is pending, cancelling previous.',
      );
      this.pendingGenerationFut.reject(new Error('Superseded by new generate_reply call'));
    }

    const fut = new Future<llm.GenerationCreatedEvent>();
    this.pendingGenerationFut = fut;

    if (this.inUserActivity) {
      this.sendClientEvent({
        activityEnd: {},
      });
      this.inUserActivity = false;
    }

    // Gemini requires the last message to end with user's turn
    // so we need to add a placeholder user turn in order to trigger a new generation
    const turns: types.Content[] = [];
    if (instructions !== undefined) {
      turns.push({
        parts: [{ text: instructions }],
        role: 'model',
      });
    }
    turns.push({
      parts: [{ text: '.' }],
      role: 'user',
    });

    this.sendClientEvent({
      turns,
      turnComplete: true,
    });

    const timeoutHandle = setTimeout(() => {
      if (!fut.done) {
        fut.reject(new Error('generateReply timed out waiting for generation_created event.'));
        if (this.pendingGenerationFut === fut) {
          this.pendingGenerationFut = undefined;
        }
      }
    }, 5000);

    fut.await.finally(() => clearTimeout(timeoutHandle));

    return fut.await;
  }

  startUserActivity(): void {
    if (!this.manualActivityDetection) {
      return;
    }

    if (!this.inUserActivity) {
      this.inUserActivity = true;
      this.sendClientEvent({
        activityStart: {},
      });
    }
  }

  async interrupt() {
    // Gemini Live treats activity start as interruption, so we rely on startUserActivity to handle it
    if (this.options.realtimeInputConfig?.activityHandling === ActivityHandling.NO_INTERRUPTION) {
      return;
    }
    this.startUserActivity();
  }

  async truncate(_options: { messageId: string; audioEndMs: number; audioTranscript?: string }) {
    this.#logger.warn('truncate is not supported by the Google Realtime API.');
  }

  async close(): Promise<void> {
    super.close();
    this.#closed = true;

    this.sessionShouldClose.set();

    await this.closeActiveSession();

    if (this.pendingGenerationFut && !this.pendingGenerationFut.done) {
      this.pendingGenerationFut.reject(new Error('Session closed'));
    }

    for (const fut of Object.values(this.responseCreatedFutures)) {
      if (!fut.done) {
        fut.reject(new Error('Session closed before response created'));
      }
    }
    this.responseCreatedFutures = {};

    if (this.currentGeneration) {
      this.markCurrentGenerationDone();
    }
  }

  #mainTask(): Promise<void> {
    return Promise.resolve();
  }

  private markCurrentGenerationDone(): void {}

  async commitAudio() {
    // Google Realtime API auto-commits audio
  }

  async clearAudio() {
    // Clear the audio buffer
    this.bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS, SAMPLE_RATE / 10);
  }

  private *resampleAudio(frame: AudioFrame): Generator<AudioFrame> {
    // For now, just pass through - TODO: implement proper resampling if needed
    yield frame;
  }
}
