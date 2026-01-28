// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Session } from '@google/genai';
import * as types from '@google/genai';
import {
  ActivityHandling,
  type AudioTranscriptionConfig,
  type ContextWindowCompressionConfig,
  GoogleGenAI,
  type HttpOptions,
  Modality,
  type RealtimeInputConfig,
} from '@google/genai';
import type { APIConnectOptions } from '@livekit/agents';
import {
  APIConnectionError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  Event,
  Future,
  Queue,
  Task,
  cancelAndWait,
  delay,
  llm,
  log,
  shortuuid,
  stream,
} from '@livekit/agents';
import { Mutex } from '@livekit/mutex';
import { AudioFrame, AudioResampler, type VideoFrame } from '@livekit/rtc-node';
import { type LLMTools } from '../../tools.js';
import { toFunctionDeclarations } from '../../utils.js';
import type * as api_proto from './api_proto.js';
import type { LiveAPIModels, Voice } from './api_proto.js';

// Input audio constants (matching Python)
const INPUT_AUDIO_SAMPLE_RATE = 16000;
const INPUT_AUDIO_CHANNELS = 1;

// Output audio constants (matching Python)
const OUTPUT_AUDIO_SAMPLE_RATE = 24000;
const OUTPUT_AUDIO_CHANNELS = 1;

const LK_GOOGLE_DEBUG = Number(process.env.LK_GOOGLE_DEBUG ?? 0);
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
  geminiTools?: LLMTools;
  thinkingConfig?: types.ThinkingConfig;
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

  get model(): string {
    return this._options.model;
  }

  constructor(
    options: {
      /**
       * Initial system instructions for the model
       */
      instructions?: string;

      /**
       * The name of the model to use
       */
      model?: LiveAPIModels | string;

      /**
       * Google Gemini API key. If not provided, will attempt to read from GOOGLE_API_KEY environment variable
       */
      apiKey?: string;

      /**
       * Voice setting for audio outputs
       */
      voice?: Voice | string;

      /**
       * The language (BCP-47 Code) to use for the API
       * See https://ai.google.dev/gemini-api/docs/live#supported-languages
       */
      language?: string;

      /**
       * Modalities to use, such as [Modality.TEXT, Modality.AUDIO]
       */
      modalities?: Modality[];

      /**
       * Whether to use VertexAI for the API
       */
      vertexai?: boolean;

      /**
       * The project ID to use for the API (for VertexAI)
       */
      project?: string;

      /**
       * The location to use for the API (for VertexAI)
       */
      location?: string;

      /**
       * The number of candidate responses to generate
       */
      candidateCount?: number;

      /**
       * Sampling temperature for response generation
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
      inputAudioTranscription?: AudioTranscriptionConfig | null;

      /**
       * The configuration for output audio transcription
       */
      outputAudioTranscription?: AudioTranscriptionConfig | null;

      /**
       * The configuration for image encoding
       */
      imageEncodeOptions?: typeof DEFAULT_IMAGE_ENCODE_OPTIONS;

      /**
       * Whether to enable affective dialog
       */
      enableAffectiveDialog?: boolean;

      /**
       * Whether to enable proactive audio
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
       */
      connOptions?: APIConnectOptions;

      /**
       * HTTP options for API requests
       */
      httpOptions?: HttpOptions;

      /**
       * Gemini-specific tools to use for the session
       */
      geminiTools?: LLMTools;

      /**
       * Thinking configuration for native audio models.
       * If not set, the model's default thinking behavior is used.
       * Use `\{ thinkingBudget: 0 \}` to disable thinking.
       * Use `\{ thinkingBudget: -1 \}` for automatic/dynamic thinking.
       */
      thinkingConfig?: types.ThinkingConfig;
    } = {},
  ) {
    const inputAudioTranscription =
      options.inputAudioTranscription === undefined ? {} : options.inputAudioTranscription;
    const outputAudioTranscription =
      options.outputAudioTranscription === undefined ? {} : options.outputAudioTranscription;

    let serverTurnDetection = true;
    if (options.realtimeInputConfig?.automaticActivityDetection?.disabled) {
      serverTurnDetection = false;
    }

    super({
      messageTruncation: false,
      turnDetection: serverTurnDetection,
      userTranscription: inputAudioTranscription !== null,
      autoToolReplyGeneration: true,
      audioOutput: options.modalities?.includes(Modality.AUDIO) ?? true,
    });

    // Environment variable fallbacks
    const apiKey = options.apiKey || process.env.GOOGLE_API_KEY;
    const project = options.project || process.env.GOOGLE_CLOUD_PROJECT;
    const location = options.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    const vertexai = options.vertexai ?? false;

    // Model selection based on API type
    const defaultModel = vertexai
      ? 'gemini-live-2.5-flash-native-audio'
      : 'gemini-2.5-flash-native-audio-preview-12-2025';

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
      inputAudioTranscription: inputAudioTranscription || undefined,
      outputAudioTranscription: outputAudioTranscription || undefined,
      imageEncodeOptions: options.imageEncodeOptions || DEFAULT_IMAGE_ENCODE_OPTIONS,
      connOptions: options.connOptions || DEFAULT_API_CONNECT_OPTIONS,
      httpOptions: options.httpOptions,
      enableAffectiveDialog: options.enableAffectiveDialog,
      proactivity: options.proactivity,
      realtimeInputConfig: options.realtimeInputConfig,
      contextWindowCompression: options.contextWindowCompression,
      apiVersion: options.apiVersion,
      geminiTools: options.geminiTools,
      thinkingConfig: options.thinkingConfig,
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
  private inputResamplerInputRate?: number;
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
  private hasReceivedAudioInput = false;
  private pendingInterruptText = false;
  private earlyCompletionPending = false;

  #client: GoogleGenAI;
  #task: Promise<void>;
  #logger = log();
  #closed = false;

  constructor(realtimeModel: RealtimeModel) {
    super(realtimeModel);

    this.options = realtimeModel._options;
    this.bstream = new AudioByteStream(
      INPUT_AUDIO_SAMPLE_RATE,
      INPUT_AUDIO_CHANNELS,
      INPUT_AUDIO_SAMPLE_RATE / 20,
    ); // 50ms chunks

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
    this.earlyCompletionPending = false;
    this.pendingInterruptText = false;

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
        const shouldSendRealtimeText = this.pendingInterruptText;

        if (shouldSendRealtimeText) {
          for (const turn of turns as types.Content[]) {
            if (turn.role !== 'user') continue;
            // Realtime text drives live activity/interrupts
            // { type: content:  turnComplete: true } alone does not reliably preempt a streaming response in Gemini Live.
            const text = (turn.parts || [])
              .map((part) => (part as { text?: string }).text)
              .filter((value): value is string => !!value)
              .join('');
            if (text) {
              this.sendClientEvent({
                type: 'realtime_input',
                value: { text },
              });
              this.pendingInterruptText = false;
            }
          }
        }

        this.sendClientEvent({
          type: 'content',
          value: {
            turns: turns as types.Content[],
            turnComplete: false,
          },
        });
      }

      if (toolResults) {
        this.sendClientEvent({
          type: 'tool_response',
          value: toolResults,
        });
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
    // Track that we've received audio input
    this.hasReceivedAudioInput = true;

    for (const f of this.resampleAudio(frame)) {
      for (const nf of this.bstream.write(f.data.buffer as ArrayBuffer)) {
        const realtimeInput: types.LiveClientRealtimeInput = {
          mediaChunks: [
            {
              mimeType: 'audio/pcm',
              data: Buffer.from(nf.data.buffer).toString('base64'),
            },
          ],
        };
        this.sendClientEvent({
          type: 'realtime_input',
          value: realtimeInput,
        });
      }
    }
  }

  pushVideo(_: VideoFrame): void {
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
        type: 'realtime_input',
        value: {
          activityEnd: {},
        },
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
      type: 'content',
      value: {
        turns,
        turnComplete: true,
      },
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
        type: 'realtime_input',
        value: {
          activityStart: {},
        },
      });
    }
  }

  private generationHasOutput(gen: ResponseGeneration): boolean {
    return Boolean(gen.outputText) || gen._firstTokenTimestamp !== undefined;
  }

  async interrupt() {
    // Gemini Live treats activity start as interruption, so we rely on startUserActivity to handle it
    if (this.options.realtimeInputConfig?.activityHandling === ActivityHandling.NO_INTERRUPTION) {
      if (LK_GOOGLE_DEBUG) {
        this.#logger.debug('interrupt skipped (activityHandling = NO_INTERRUPTION)');
      }
      return;
    }
    if (this.currentGeneration && !this.currentGeneration._done) {
      this.pendingInterruptText = true;
      if (this.generationHasOutput(this.currentGeneration)) {
        this.earlyCompletionPending = true;
        this.markCurrentGenerationDone();
      }
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

  async #mainTask(): Promise<void> {
    const maxRetries = this.options.connOptions.maxRetry;

    while (!this.#closed) {
      // previous session might not be closed yet, we'll do it here.
      await this.closeActiveSession();

      this.sessionShouldClose.clear();
      const config = this.buildConnectConfig();

      try {
        this.#logger.debug('Connecting to Gemini Realtime API...');

        const sessionOpened = new Event();
        const session = await this.#client.live.connect({
          model: this.options.model,
          callbacks: {
            onopen: () => sessionOpened.set(),
            onmessage: (message: types.LiveServerMessage) => {
              this.onReceiveMessage(session, message);
            },
            onerror: (error: ErrorEvent) => {
              this.#logger.error('Gemini Live session error:', error);
              if (!this.sessionShouldClose.isSet) {
                this.markRestartNeeded();
              }
            },
            onclose: (event: CloseEvent) => {
              this.#logger.debug('Gemini Live session closed:', event.code, event.reason);
              this.markCurrentGenerationDone();
            },
          },
          config,
        });

        await sessionOpened.wait();

        const unlock = await this.sessionLock.lock();
        try {
          this.activeSession = session;

          // Send existing chat context
          const [turns] = await this._chatCtx
            .copy({
              excludeFunctionCall: true,
            })
            .toProviderFormat('google', false);

          if (turns.length > 0) {
            await session.sendClientContent({
              turns,
              turnComplete: false,
            });
          }
        } finally {
          unlock();
        }

        const sendTask = Task.from((controller) => this.sendTask(session, controller));
        const restartWaitTask = Task.from(({ signal }) => {
          const abortEvent = new Event();
          signal.addEventListener('abort', () => abortEvent.set());
          return Promise.race([this.sessionShouldClose.wait(), abortEvent.wait()]);
        });

        await Promise.race([sendTask.result, restartWaitTask.result]);

        // TODO(brian): handle error from tasks

        if (!restartWaitTask.done && this.#closed) {
          break;
        }

        await cancelAndWait([sendTask, restartWaitTask], 2000);
      } catch (error) {
        this.#logger.error(`Gemini Realtime API error: ${error}`);

        if (this.#closed) break;

        if (maxRetries === 0) {
          this.emitError(error as Error, false);
          throw new APIConnectionError({
            message: 'Failed to connect to Gemini Live',
          });
        }

        if (this.numRetries >= maxRetries) {
          this.emitError(error as Error, false);
          throw new APIConnectionError({
            message: `Failed to connect to Gemini Live after ${maxRetries} attempts`,
          });
        }

        const retryInterval =
          this.numRetries === 100 ? 0 : this.options.connOptions.retryIntervalMs;

        this.#logger.warn(
          {
            attempt: this.numRetries,
            maxRetries,
          },
          `Gemini Realtime API connection failed, retrying in ${retryInterval}ms`,
        );

        await delay(retryInterval);
        this.numRetries++;
      } finally {
        await this.closeActiveSession();
      }
    }
  }

  private async sendTask(session: types.Session, controller: AbortController): Promise<void> {
    try {
      while (!this.#closed && !this.sessionShouldClose.isSet && !controller.signal.aborted) {
        const msg = await this.messageChannel.get();
        if (controller.signal.aborted) break;

        const unlock = await this.sessionLock.lock();
        try {
          if (this.sessionShouldClose.isSet || this.activeSession !== session) {
            break;
          }
        } finally {
          unlock();
        }

        switch (msg.type) {
          case 'content':
            const { turns, turnComplete } = msg.value;
            if (LK_GOOGLE_DEBUG) {
              this.#logger.debug(`(client) -> ${JSON.stringify(this.loggableClientEvent(msg))}`);
            }
            await session.sendClientContent({
              turns,
              turnComplete: turnComplete ?? true,
            });
            break;
          case 'tool_response':
            const { functionResponses } = msg.value;
            if (functionResponses) {
              if (LK_GOOGLE_DEBUG) {
                this.#logger.debug(`(client) -> ${JSON.stringify(this.loggableClientEvent(msg))}`);
              }
              await session.sendToolResponse({
                functionResponses,
              });
            }
            break;
          case 'realtime_input':
            const { mediaChunks, activityStart, activityEnd, text } = msg.value;
            if (mediaChunks) {
              for (const mediaChunk of mediaChunks) {
                await session.sendRealtimeInput({ media: mediaChunk });
              }
            }
            if (text) {
              await session.sendRealtimeInput({ text });
            }
            if (activityStart) await session.sendRealtimeInput({ activityStart });
            if (activityEnd) await session.sendRealtimeInput({ activityEnd });
            break;
          default:
            this.#logger.warn(`Warning: Received unhandled message type: ${msg.type}`);
            break;
        }
      }
    } catch (e) {
      if (!this.sessionShouldClose.isSet) {
        this.#logger.error(`Error in send task: ${e}`);
        this.markRestartNeeded();
      }
    } finally {
      this.#logger.debug(
        {
          closed: this.#closed,
          sessionShouldClose: this.sessionShouldClose.isSet,
          aborted: controller.signal.aborted,
        },
        'send task finished.',
      );
    }
  }

  private async onReceiveMessage(
    session: types.Session,
    response: types.LiveServerMessage,
  ): Promise<void> {
    // Skip logging verbose audio data events
    const hasAudioData = response.serverContent?.modelTurn?.parts?.some(
      (part) => part.inlineData?.data,
    );
    if (LK_GOOGLE_DEBUG) {
      this.#logger.debug(`(server) <- ${JSON.stringify(this.loggableServerMessage(response))}`);
    } else if (!hasAudioData) {
      this.#logger.debug(`(server) <- ${JSON.stringify(this.loggableServerMessage(response))}`);
    }
    const unlock = await this.sessionLock.lock();

    try {
      if (this.sessionShouldClose.isSet || this.activeSession !== session) {
        this.#logger.debug('onReceiveMessage: Session changed or closed, stopping receive.');
        return;
      }
    } finally {
      unlock();
    }

    const shouldStartNewGeneration =
      !this.currentGeneration || this.currentGeneration._done || !!this.pendingGenerationFut;
    if (shouldStartNewGeneration) {
      if (response.serverContent?.interrupted) {
        // Two cases when an interrupted event is sent without an active generation:
        // 1) generation done but playout not finished (turnComplete -> interrupted)
        // 2) generation not started (interrupted -> turnComplete)
        if (!this.pendingGenerationFut) {
          this.handleInputSpeechStarted();
        }

        response.serverContent = {
          ...response.serverContent,
          interrupted: undefined,
        };

        const sc = response.serverContent;
        const hasServerContent =
          !!sc?.modelTurn ||
          sc?.outputTranscription != null ||
          sc?.inputTranscription != null ||
          sc?.generationComplete != null ||
          sc?.turnComplete != null;
        if (!hasServerContent) {
          response.serverContent = undefined;
          if (LK_GOOGLE_DEBUG) {
            this.#logger.debug('ignoring empty server content');
          }
        }
      }

      // start new generation for serverContent or for standalone toolCalls
      if (this.isNewGeneration(response)) {
        this.startNewGeneration();
        if (LK_GOOGLE_DEBUG) {
          this.#logger.debug(`new generation started: ${this.currentGeneration?.responseId}`);
        }
      }
    }
    if (response.sessionResumptionUpdate) {
      if (
        response.sessionResumptionUpdate.resumable &&
        response.sessionResumptionUpdate.newHandle
      ) {
        this.sessionResumptionHandle = response.sessionResumptionUpdate.newHandle;
      }
    }

    try {
      if (response.serverContent) {
        this.handleServerContent(response.serverContent);
      }

      if (response.toolCall) {
        this.handleToolCall(response.toolCall);
      }

      if (response.toolCallCancellation) {
        this.handleToolCallCancellation(response.toolCallCancellation);
      }

      if (response.usageMetadata) {
        this.handleUsageMetadata(response.usageMetadata);
      }

      if (response.goAway) {
        this.handleGoAway(response.goAway);
      }

      if (this.numRetries > 0) {
        this.numRetries = 0;
      }
    } catch (e) {
      if (!this.sessionShouldClose.isSet) {
        this.#logger.error(`Error in onReceiveMessage: ${e}`);
        this.markRestartNeeded();
      }
    }
  }

  /// Truncate large base64/audio payloads for logging to avoid flooding logs
  private truncateString(data: string, maxLength: number = 30): string {
    return data.length > maxLength ? `${data.slice(0, maxLength)}…` : data;
  }

  private loggableClientEvent(
    event: api_proto.ClientEvents,
    maxLength: number = 30,
  ): Record<string, unknown> {
    const obj: any = { ...event };
    if (obj.type === 'realtime_input' && obj.value?.mediaChunks) {
      obj.value = {
        ...obj.value,
        mediaChunks: (obj.value.mediaChunks as Array<{ mimeType?: string; data?: string }>).map(
          (mc) => ({
            ...mc,
            data: typeof mc.data === 'string' ? this.truncateString(mc.data, maxLength) : mc.data,
          }),
        ),
      };
    }
    return obj;
  }

  private loggableServerMessage(
    message: types.LiveServerMessage,
    maxLength: number = 30,
  ): Record<string, unknown> {
    const obj: any = { ...message };
    if (
      obj.serverContent &&
      obj.serverContent.modelTurn &&
      Array.isArray(obj.serverContent.modelTurn.parts)
    ) {
      obj.serverContent = { ...obj.serverContent };
      obj.serverContent.modelTurn = { ...obj.serverContent.modelTurn };
      obj.serverContent.modelTurn.parts = obj.serverContent.modelTurn.parts.map((part: any) => {
        if (part?.inlineData?.data && typeof part.inlineData.data === 'string') {
          return {
            ...part,
            inlineData: {
              ...part.inlineData,
              data: this.truncateString(part.inlineData.data, maxLength),
            },
          };
        }
        return part;
      });
    }
    return obj;
  }

  private markCurrentGenerationDone(keepFunctionChannelOpen: boolean = false): void {
    if (!this.currentGeneration || this.currentGeneration._done) {
      return;
    }

    this.handleInputSpeechStopped();

    const gen = this.currentGeneration;

    // The only way we'd know that the transcription is complete is by when they are
    // done with generation
    if (gen.inputTranscription) {
      this.emit('input_audio_transcription_completed', {
        itemId: gen.inputId,
        transcript: gen.inputTranscription,
        isFinal: true,
      } as llm.InputTranscriptionCompleted);

      // since gemini doesn't give us a view of the chat history on the server side,
      // we would handle it manually here
      this._chatCtx.addMessage({
        role: 'user',
        content: gen.inputTranscription,
        id: gen.inputId,
      });
    }

    if (gen.outputText) {
      this._chatCtx.addMessage({
        role: 'assistant',
        content: gen.outputText,
        id: gen.responseId,
      });
    }

    if (this.options.outputAudioTranscription === undefined) {
      // close the text data of transcription synchronizer
      gen.textChannel.write('');
    }

    gen.textChannel.close();
    gen.audioChannel.close();
    if (!keepFunctionChannelOpen) {
      gen.functionChannel.close();
    }
    gen.messageChannel.close();
    gen._done = true;
  }

  private emitError(error: Error, recoverable: boolean): void {
    this.emit('error', {
      timestamp: Date.now(),
      // TODO(brian): add label to realtime model
      label: 'google_realtime',
      error,
      recoverable,
    });
  }

  private buildConnectConfig(): types.LiveConnectConfig {
    const opts = this.options;

    const config: types.LiveConnectConfig = {
      thinkingConfig: opts.thinkingConfig,
      responseModalities: opts.responseModalities,
      systemInstruction: opts.instructions
        ? {
            parts: [{ text: opts.instructions }],
          }
        : undefined,
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: opts.voice as Voice,
          },
        },
        languageCode: opts.language,
      },
      tools: [
        {
          functionDeclarations: this.geminiDeclarations,
          ...this.options.geminiTools,
        },
      ],
      inputAudioTranscription: opts.inputAudioTranscription,
      outputAudioTranscription: opts.outputAudioTranscription,
      sessionResumption: {
        handle: this.sessionResumptionHandle,
      },
    };

    // Add generation fields at TOP LEVEL (NO generationConfig!)
    if (opts.temperature !== undefined) {
      config.temperature = opts.temperature;
    }
    if (opts.maxOutputTokens !== undefined) {
      config.maxOutputTokens = opts.maxOutputTokens;
    }
    if (opts.topP !== undefined) {
      config.topP = opts.topP;
    }
    if (opts.topK !== undefined) {
      config.topK = opts.topK;
    }

    if (opts.proactivity !== undefined) {
      config.proactivity = { proactiveAudio: opts.proactivity };
    }

    if (opts.enableAffectiveDialog !== undefined) {
      config.enableAffectiveDialog = opts.enableAffectiveDialog;
    }

    if (opts.realtimeInputConfig !== undefined) {
      config.realtimeInputConfig = opts.realtimeInputConfig;
    }

    if (opts.contextWindowCompression !== undefined) {
      config.contextWindowCompression = opts.contextWindowCompression;
    }

    return config;
  }

  private startNewGeneration(): void {
    // close functionChannel of previous generation if still open (no toolCall arrived)
    if (this.currentGeneration && !this.currentGeneration.functionChannel.closed) {
      this.currentGeneration.functionChannel.close();
    }

    if (this.currentGeneration && !this.currentGeneration._done) {
      this.#logger.warn('Starting new generation while another is active. Finalizing previous.');
      this.markCurrentGenerationDone();
    }

    const responseId = shortuuid('GR_');
    this.currentGeneration = {
      messageChannel: stream.createStreamChannel<llm.MessageGeneration>(),
      functionChannel: stream.createStreamChannel<llm.FunctionCall>(),
      responseId,
      inputId: shortuuid('GI_'),
      textChannel: stream.createStreamChannel<string>(),
      audioChannel: stream.createStreamChannel<AudioFrame>(),
      inputTranscription: '',
      outputText: '',
      _createdTimestamp: Date.now(),
      _done: false,
    };

    // Close audio stream if audio output is not supported by the model
    if (!this._realtimeModel.capabilities.audioOutput) {
      this.currentGeneration.audioChannel.close();
    }

    // Determine modalities based on the model's audio_output capability
    const modalities: ('text' | 'audio')[] = this._realtimeModel.capabilities.audioOutput
      ? ['audio', 'text']
      : ['text'];

    this.currentGeneration.messageChannel.write({
      messageId: responseId,
      textStream: this.currentGeneration.textChannel.stream(),
      audioStream: this.currentGeneration.audioChannel.stream(),
      modalities: Promise.resolve(modalities),
    });

    const generationEvent: llm.GenerationCreatedEvent = {
      messageStream: this.currentGeneration.messageChannel.stream(),
      functionStream: this.currentGeneration.functionChannel.stream(),
      userInitiated: false,
      responseId,
    };

    if (this.pendingGenerationFut && !this.pendingGenerationFut.done) {
      generationEvent.userInitiated = true;
      this.pendingGenerationFut.resolve(generationEvent);
      this.pendingGenerationFut = undefined;
    } else {
      // emit input_speech_started event before starting an agent initiated generation
      // to interrupt the previous audio playout if any
      this.handleInputSpeechStarted();
    }

    this.emit('generation_created', generationEvent);
  }

  private handleInputSpeechStarted(): void {
    this.emit('input_speech_started', {} as llm.InputSpeechStartedEvent);
  }

  private handleInputSpeechStopped(): void {
    this.emit('input_speech_stopped', {
      userTranscriptionEnabled: false,
    } as llm.InputSpeechStoppedEvent);
  }

  private handleServerContent(serverContent: types.LiveServerContent): void {
    if (!this.currentGeneration) {
      this.#logger.warn('received server content but no active generation.');
      return;
    }

    const gen = this.currentGeneration;

    const discardOutput = this.earlyCompletionPending;

    if (serverContent.modelTurn && !discardOutput) {
      const turn = serverContent.modelTurn;

      for (const part of turn.parts || []) {
        // bypass reasoning/thought output
        if (part.thought) {
          continue;
        }

        if (part.text) {
          gen.outputText += part.text;
          gen.textChannel.write(part.text);
        }

        if (part.inlineData) {
          if (!gen._firstTokenTimestamp) {
            gen._firstTokenTimestamp = Date.now();
          }

          try {
            if (!part.inlineData.data) {
              throw new Error('frameData is not bytes');
            }

            const binaryString = atob(part.inlineData.data);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }

            const int16Array = new Int16Array(bytes.buffer);
            const audioFrame = new AudioFrame(
              int16Array,
              OUTPUT_AUDIO_SAMPLE_RATE,
              OUTPUT_AUDIO_CHANNELS,
              int16Array.length / OUTPUT_AUDIO_CHANNELS,
            );

            gen.audioChannel.write(audioFrame);
          } catch (error) {
            this.#logger.error('Error processing audio data:', error);
          }
        }
      }
    }

    if (serverContent.inputTranscription && serverContent.inputTranscription.text) {
      let text = serverContent.inputTranscription.text;

      if (gen.inputTranscription === '') {
        text = text.trimStart();
      }

      gen.inputTranscription += text;
      this.emit('input_audio_transcription_completed', {
        itemId: gen.inputId,
        transcript: gen.inputTranscription,
        isFinal: false,
      } as llm.InputTranscriptionCompleted);
    }

    if (
      !discardOutput &&
      serverContent.outputTranscription &&
      serverContent.outputTranscription.text
    ) {
      const text = serverContent.outputTranscription.text;
      gen.outputText += text;
      gen.textChannel.write(text);
    }

    if (serverContent.generationComplete || serverContent.turnComplete) {
      gen._completedTimestamp = Date.now();
    }

    if (serverContent.interrupted && !this.pendingGenerationFut) {
      this.handleInputSpeechStarted();
    }

    if (serverContent.turnComplete && !this.earlyCompletionPending) {
      this.markCurrentGenerationDone();
    }

    // Assume Gemini emits turnComplete/generationComplete before any new generation content.
    // We keep discarding until that signal to avoid old stream spillover after interrupts.
    if (
      this.earlyCompletionPending &&
      (serverContent.turnComplete || serverContent.generationComplete)
    ) {
      this.earlyCompletionPending = false;
    }
  }

  private handleToolCall(toolCall: types.LiveServerToolCall): void {
    if (!this.currentGeneration) {
      this.#logger.warn('received tool call but no active generation.');
      return;
    }

    const gen = this.currentGeneration;

    if (gen.functionChannel.closed) {
      this.#logger.warn('received tool call but functionChannel is already closed.');
      return;
    }

    for (const fc of toolCall.functionCalls || []) {
      if (!fc.name) {
        this.#logger.warn('received function call without name, skipping');
        continue;
      }
      gen.functionChannel.write(
        llm.FunctionCall.create({
          callId: fc.id || shortuuid('fnc-call-'),
          name: fc.name,
          args: fc.args ? JSON.stringify(fc.args) : '',
        }),
      );
    }

    gen.functionChannel.close();
    this.markCurrentGenerationDone();
  }

  private handleToolCallCancellation(cancellation: types.LiveServerToolCallCancellation): void {
    this.#logger.warn(
      {
        functionCallIds: cancellation.ids,
      },
      'server cancelled tool calls',
    );
  }

  private handleUsageMetadata(usage: types.UsageMetadata): void {
    if (!this.currentGeneration) {
      this.#logger.debug('Received usage metadata but no active generation');
      return;
    }

    const gen = this.currentGeneration;
    const createdTimestamp = gen._createdTimestamp;
    const firstTokenTimestamp = gen._firstTokenTimestamp;
    const completedTimestamp = gen._completedTimestamp || Date.now();

    // Calculate metrics
    const ttftMs = firstTokenTimestamp ? firstTokenTimestamp - createdTimestamp : -1;
    const durationMs = completedTimestamp - createdTimestamp;

    const inputTokens = usage.promptTokenCount || 0;
    const outputTokens = usage.responseTokenCount || 0;
    const totalTokens = usage.totalTokenCount || 0;

    const realtimeMetrics = {
      type: 'realtime_model_metrics',
      timestamp: createdTimestamp,
      requestId: gen.responseId,
      ttftMs,
      durationMs,
      cancelled: gen._done && !gen._completedTimestamp,
      label: 'google_realtime',
      inputTokens,
      outputTokens,
      totalTokens,
      tokensPerSecond: durationMs > 0 ? outputTokens / (durationMs / 1000) : 0,
      inputTokenDetails: {
        ...this.tokenDetailsMap(usage.promptTokensDetails),
        cachedTokens: (usage.cacheTokensDetails || []).reduce(
          (sum, detail) => sum + (detail.tokenCount || 0),
          0,
        ),
        cachedTokensDetails: this.tokenDetailsMap(usage.cacheTokensDetails),
      },
      outputTokenDetails: this.tokenDetailsMap(usage.responseTokensDetails),
    };

    this.emit('metrics_collected', realtimeMetrics);
  }

  private tokenDetailsMap(tokenDetails: types.ModalityTokenCount[] | undefined): {
    audioTokens: number;
    textTokens: number;
    imageTokens: number;
  } {
    const tokenDetailsMap = { audioTokens: 0, textTokens: 0, imageTokens: 0 };
    if (!tokenDetails) {
      return tokenDetailsMap;
    }

    for (const tokenDetail of tokenDetails) {
      if (!tokenDetail.tokenCount) {
        continue;
      }

      if (tokenDetail.modality === types.MediaModality.AUDIO) {
        tokenDetailsMap.audioTokens += tokenDetail.tokenCount;
      } else if (tokenDetail.modality === types.MediaModality.TEXT) {
        tokenDetailsMap.textTokens += tokenDetail.tokenCount;
      } else if (tokenDetail.modality === types.MediaModality.IMAGE) {
        tokenDetailsMap.imageTokens += tokenDetail.tokenCount;
      }
    }
    return tokenDetailsMap;
  }

  private handleGoAway(goAway: types.LiveServerGoAway): void {
    this.#logger.warn({ timeLeft: goAway.timeLeft }, 'Gemini server indicates disconnection soon.');
    // TODO(brian): this isn't a seamless reconnection just yet
    this.sessionShouldClose.set();
  }

  async commitAudio() {}

  async clearAudio() {}

  private *resampleAudio(frame: AudioFrame): Generator<AudioFrame> {
    if (this.inputResampler) {
      if (frame.sampleRate !== this.inputResamplerInputRate) {
        // input audio changed to a different sample rate
        this.inputResampler = undefined;
        this.inputResamplerInputRate = undefined;
      }
    }

    if (
      this.inputResampler === undefined &&
      (frame.sampleRate !== INPUT_AUDIO_SAMPLE_RATE || frame.channels !== INPUT_AUDIO_CHANNELS)
    ) {
      this.inputResampler = new AudioResampler(
        frame.sampleRate,
        INPUT_AUDIO_SAMPLE_RATE,
        INPUT_AUDIO_CHANNELS,
      );
      this.inputResamplerInputRate = frame.sampleRate;
    }

    if (this.inputResampler) {
      // TODO(brian): flush the resampler when the input source is changed
      for (const resampledFrame of this.inputResampler.push(frame)) {
        yield resampledFrame;
      }
    } else {
      yield frame;
    }
  }

  private isNewGeneration(response: types.LiveServerMessage) {
    if (this.earlyCompletionPending) {
      return false;
    }
    if (response.toolCall) {
      return true;
    }

    const serverContent = response.serverContent;
    return (
      !!serverContent &&
      (serverContent.modelTurn ||
        serverContent.outputTranscription != null ||
        serverContent.inputTranscription != null ||
        serverContent.generationComplete != null ||
        serverContent.turnComplete != null)
    );
  }
}
