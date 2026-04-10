// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import {
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  Future,
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
const TOOL_CALL_OUTPUT_TIMEOUT_MS = 60_000;
const CONVERSATION_HISTORY_PREFIX =
  '\n\nThis conversation is being continued from an existing ' +
  'conversation. You are the assistant speaking to the user. ' +
  'The following is the conversation history:\n';

export interface RealtimeModelOptions {
  apiKey: string;
  model: string;
  phonicAgent?: string;
  voice?: Voice | string;
  welcomeMessage?: string;
  generateWelcomeMessage?: boolean;
  project?: string;
  connOptions: APIConnectOptions;
  baseUrl?: string;
  defaultLanguage?: string;
  additionalLanguages?: string[];
  multilingualMode?: 'auto' | 'request';
  audioSpeed?: number;
  phonicTools?: string[];
  boostedKeywords?: string[];
  generateNoInputPokeText?: boolean;
  noInputPokeSec?: number;
  noInputPokeText?: string;
  noInputEndConversationSec?: number;
  /** Set by `updateInstructions` via `voice.Agent` rather than the RealtimeModel constructor */
  instructions?: string;
}

export class RealtimeModel extends llm.RealtimeModel {
  /** @internal */
  _options: RealtimeModelOptions;

  get model(): string {
    return this._options.model;
  }

  get provider(): string {
    return 'phonic';
  }

  constructor(
    options: {
      /**
       * Phonic API key. If not provided, will attempt to read from PHONIC_API_KEY environment variable
       */
      apiKey?: string;
      /**
       * The name of the model to use. Defaults to 'merritt'
       */
      model?: Phonic.ConfigPayload['model'] | string;
      /**
       * Phonic agent to use for the conversation. Options explicitly set here will override the agent settings.
       */
      phonicAgent?: string;
      /**
       * Voice ID for agent outputs
       */
      voice?: Voice;
      /**
       * Welcome message for the agent to say when the conversation starts. Ignored when generateWelcomeMessage is true
       */
      welcomeMessage?: string;
      /**
       * When true, the welcome message will be automatically generated and welcomeMessage will be ignored
       */
      generateWelcomeMessage?: boolean;
      /**
       * Project name to use for the conversation. Defaults to `main`
       */
      project?: string;
      /**
       * ISO 639-1 default language for recognition and speech
       */
      defaultLanguage?: string;
      /**
       * Further ISO 639-1 codes (must not include `defaultLanguage`)
       */
      additionalLanguages?: string[];
      /**
       * `auto`: detect language per utterance. `request`: switch only when the user asks (recommended).
       */
      multilingualMode?: 'auto' | 'request';
      /**
       * Deprecated. Use `defaultLanguage` and `additionalLanguages` instead.
       * When both of those are omitted and this is set, `languages[0]` is the default
       * language and `languages.slice(1)` are additional languages.
       */
      languages?: string[];
      /**
       * Audio playback speed
       */
      audioSpeed?: number;
      /**
       * Phonic tool names available to the assistant
       */
      phonicTools?: string[];
      /**
       * Keywords to boost in speech recognition
       */
      boostedKeywords?: string[];
      /**
       * Auto-generate poke text when user is silent
       */
      generateNoInputPokeText?: boolean;
      /**
       * Seconds of silence before sending poke message
       */
      noInputPokeSec?: number;
      /**
       * Poke message text (ignored when generateNoInputPokeText is true)
       */
      noInputPokeText?: string;
      /**
       * Seconds of silence before ending conversation
       */
      noInputEndConversationSec?: number;
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
      autoToolReplyGeneration: true,
      manualFunctionCalls: false,
      audioOutput: true,
      midSessionChatCtxUpdate: true,
      midSessionInstructionsUpdate: true,
      midSessionToolsUpdate: true,
      perResponseToolChoice: false,
    });

    const apiKey = options.apiKey || process.env.PHONIC_API_KEY;
    if (!apiKey) {
      throw new Error('Phonic API key is required. Provide apiKey or set PHONIC_API_KEY.');
    }

    let defaultLanguage = options.defaultLanguage;
    let additionalLanguages = options.additionalLanguages;
    if (
      options.languages !== undefined &&
      options.defaultLanguage === undefined &&
      options.additionalLanguages === undefined
    ) {
      if (options.languages.length > 0) {
        defaultLanguage = options.languages[0];
      }
      if (options.languages.length > 1) {
        additionalLanguages = options.languages.slice(1);
      }
    }

    this._options = {
      apiKey,
      voice: options.voice,
      phonicAgent: options.phonicAgent,
      project: options.project,
      welcomeMessage: options.welcomeMessage,
      generateWelcomeMessage: options.generateWelcomeMessage,
      defaultLanguage,
      additionalLanguages,
      multilingualMode: options.multilingualMode,
      audioSpeed: options.audioSpeed,
      phonicTools: options.phonicTools,
      boostedKeywords: options.boostedKeywords,
      generateNoInputPokeText: options.generateNoInputPokeText,
      noInputPokeSec: options.noInputPokeSec,
      noInputPokeText: options.noInputPokeText,
      noInputEndConversationSec: options.noInputEndConversationSec,
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
  private conversationId?: string;

  private client: PhonicClient;
  private socket?: Awaited<ReturnType<PhonicClient['conversations']['connect']>>;
  private logger = log();
  private closed = false;
  private configSent = false;
  private instructionsReady = new Future<void>();
  private toolsReady = new Future<void>();
  private closedFuture = new Future<void>();
  private connectTask: Promise<void>;
  private toolDefinitions: Record<string, unknown>[] = [];
  private pendingToolCallIds = new Set<string>();
  private readyToStart = new Future<void>();
  private pendingGenerateReplyFut?: Future<llm.GenerationCreatedEvent>;
  private generateReplyRequestId = 0;
  private systemPromptPostfix = '';

  constructor(realtimeModel: RealtimeModel) {
    super(realtimeModel);
    this.options = realtimeModel._options;

    this.client = new PhonicClient({
      apiKey: this.options.apiKey,
      baseUrl: this.options.baseUrl,
    });
    this.bstream = new AudioByteStream(
      PHONIC_INPUT_SAMPLE_RATE,
      PHONIC_NUM_CHANNELS,
      (PHONIC_INPUT_SAMPLE_RATE * PHONIC_INPUT_FRAME_MS) / 1000,
    );
    this.connectTask = this.connect().catch((error: unknown) => {
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

  async updateInstructions(instructions: string): Promise<void> {
    if (this.configSent) {
      this.logger.warn(
        'updateInstructions called after config was already sent. Phonic does not support updating instructions mid-session.',
      );
      return;
    }
    this.options.instructions = instructions;
    this.instructionsReady.resolve();
  }

  async updateChatCtx(chatCtx: llm.ChatContext): Promise<void> {
    if (!this.configSent) {
      if (chatCtx.items.length > 0) {
        const turnHistory = chatCtx.items
          .filter(
            (item): item is llm.ChatMessage =>
              item.type === 'message' &&
              'textContent' in item &&
              item.textContent !== undefined &&
              item.textContent.trim() !== '',
          )
          .map((item) => `${item.role}: ${item.textContent}`)
          .join('\n');
        if (turnHistory.trim() !== '') {
          this.logger.debug(
            'updateChatCtx called with messages prior to config being sent to Phonic. Including conversation state in system instructions.',
          );
          this.systemPromptPostfix = CONVERSATION_HISTORY_PREFIX + turnHistory;
        }
        this._chatCtx = chatCtx.copy();
      }
      return;
    }

    const diffOps = llm.computeChatCtxDiff(this._chatCtx, chatCtx);
    let sentToolCallOutput = false;
    let sentAddSystemMessage = false;

    for (const [, itemId] of diffOps.toCreate) {
      const item = chatCtx.getById(itemId);
      if (item?.type === 'function_call_output' && this.pendingToolCallIds.has(item.callId)) {
        this.pendingToolCallIds.delete(item.callId);
        this.logger.info(`Sending tool call output for ${item.name} (call_id: ${item.callId})`);
        this.socket?.sendToolCallOutput({
          type: 'tool_call_output',
          tool_call_id: item.callId,
          output: item.output,
        });
        sentToolCallOutput = true;
      }
      if (item?.type === 'message') {
        if ((item.role === 'system' || item.role === 'developer') && item.textContent) {
          this.logger.debug(`Sending add system message: ${item.textContent}`);
          this.socket?.sendAddSystemMessage({
            type: 'add_system_message',
            system_message: item.textContent,
          });
          sentAddSystemMessage = true;
        }
      }
    }

    this._chatCtx = chatCtx.copy();

    if (!sentToolCallOutput && !sentAddSystemMessage) {
      this.logger.warn(
        'updateChatCtx called but no new tool call outputs to send. Phonic does not support general chat context updates.',
      );
    }
    if (sentToolCallOutput) {
      this.startNewAssistantTurn({ userInitiated: false });
    }
  }

  async updateTools(tools: llm.ToolContext): Promise<void> {
    if (this.configSent) {
      this.logger.warn(
        'updateTools called after config was already sent. Phonic does not support updating tools mid-session.',
      );
      return;
    }

    this._tools = { ...tools };
    this.toolDefinitions = Object.entries(tools)
      .filter(([_, tool]) => llm.isFunctionTool(tool))
      .map(([name, tool]) => ({
        type: 'custom_websocket',
        tool_schema: {
          type: 'function',
          function: {
            name,
            description: tool.description,
            parameters: llm.toJsonSchema(tool.parameters),
            strict: true,
          },
        },
        tool_call_output_timeout_ms: TOOL_CALL_OUTPUT_TIMEOUT_MS,
        // Tool chaining and tool calls during speech are not supported at this time
        // for ease of implementation within the RealtimeSession generations framework
        wait_for_speech_before_tool_call: true,
        allow_tool_chaining: false,
      }));

    this.toolsReady.resolve();
  }

  async _updateSession(
    instructions?: string,
    chatCtx?: llm.ChatContext,
    tools?: llm.ToolContext,
  ): Promise<void> {
    await this.readyToStart.await;
    if (instructions !== undefined) {
      this.options.instructions = instructions;
    }
    if (tools !== undefined) {
      this._tools = { ...tools };
      this.toolDefinitions = Object.entries(tools)
        .filter(([, tool]) => llm.isFunctionTool(tool))
        .map(([name, tool]) => ({
          type: 'custom_websocket',
          tool_schema: {
            type: 'function',
            function: {
              name,
              description: tool.description,
              parameters: llm.toJsonSchema(tool.parameters),
              strict: true,
            },
          },
          tool_call_output_timeout_ms: TOOL_CALL_OUTPUT_TIMEOUT_MS,
          wait_for_speech_before_tool_call: true,
          allow_tool_chaining: false,
        }));
    }
    if (chatCtx !== undefined) {
      this._chatCtx = chatCtx.copy();
    }

    let systemPrompt = this.options.instructions ?? '';
    if (chatCtx !== undefined) {
      const history = this.buildTurnHistory(chatCtx);
      if (history) {
        systemPrompt += CONVERSATION_HISTORY_PREFIX + history;
      }
    }

    this.closeCurrentGeneration({ interrupted: true });

    const toolsPayload: Phonic.ConfigOptions.Tools.Item[] = [
      ...(this.options.phonicTools ?? []),
      ...this.toolDefinitions,
    ];

    if (this.socket) {
      this.logger.info('Sending mid-session reset to Phonic');
      this.socket.sendReset({
        type: 'reset',
        config: this.buildConfigOptions({ systemPrompt, toolsPayload }),
      });
    }
  }

  updateOptions(_options: { toolChoice?: llm.ToolChoice | null }): void {
    this.logger.warn('updateOptions is not supported by the Phonic realtime model.');
  }

  pushAudio(frame: AudioFrame): void {
    if (this.closed || !this.readyToStart.done) {
      return;
    }

    for (const resampledFrame of this.resampleAudio(frame)) {
      for (const chunk of this.bstream.write(resampledFrame.data.buffer as ArrayBuffer)) {
        const bytes = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
        const payload: Phonic.AudioChunkPayload = {
          type: 'audio_chunk',
          audio: bytes.toString('base64'),
        };

        if (!this.socket) {
          continue;
        }
        this.socket.sendAudioChunk(payload);
      }
    }
  }

  async generateReply(instructions?: string): Promise<llm.GenerationCreatedEvent> {
    if (this.closed) {
      return Promise.reject(new Error('session is closed'));
    }

    if (this.pendingGenerateReplyFut && !this.pendingGenerateReplyFut.done) {
      this.pendingGenerateReplyFut.reject(
        new Error('generateReply superseded by a newer generateReply call'),
      );
    }

    const requestId = ++this.generateReplyRequestId;
    this.closeCurrentGeneration({ interrupted: false });
    this.pendingGenerateReplyFut = new Future<llm.GenerationCreatedEvent>();
    this.sendGenerateReply(instructions, requestId);

    return this.pendingGenerateReplyFut.await;
  }

  private async sendGenerateReply(
    instructions: string | undefined,
    requestId: number,
  ): Promise<void> {
    await this.readyToStart.await;
    if (requestId !== this.generateReplyRequestId) {
      return;
    }

    if (this.closed || !this.socket) {
      this.pendingGenerateReplyFut?.reject(new Error('session is closed'));
      this.pendingGenerateReplyFut = undefined;
      return;
    }
    this.socket.sendGenerateReply({ type: 'generate_reply', system_message: instructions });
  }

  async commitAudio(): Promise<void> {
    this.logger.warn('commitAudio is not supported by the Phonic realtime model.');
  }
  async clearAudio(): Promise<void> {
    this.logger.warn('clearAudio is not supported by the Phonic realtime model.');
  }

  async interrupt(): Promise<void> {
    this.logger.warn(
      'interrupt() is not supported by Phonic realtime model. User interruptions are automatically handled by Phonic.',
    );
  }

  async truncate(_options: { messageId: string; audioEndMs: number; audioTranscript?: string }) {
    this.logger.warn('truncate is not supported by the Phonic realtime model.');
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closedFuture.resolve();
    this.instructionsReady.resolve();
    this.toolsReady.resolve();
    this.readyToStart.resolve();
    this.closeCurrentGeneration({ interrupted: false });
    this.rejectPendingGenerateReply();
    this.inputResampler = undefined;
    this.socket?.close();
    await this.connectTask;
    await super.close();
  }

  private async connect(): Promise<void> {
    this.socket = await this.client.conversations.connect({
      reconnectAttempts: this.options.connOptions.maxRetry,
    });

    if (this.closed) {
      this.socket.close();
      return;
    }

    this.socket.on('message', (message: unknown) =>
      this.handleServerMessage(message as ServerEvent),
    );
    this.socket.on('error', (error: Error) => this.emitError(error, false));
    this.socket.on('close', (event: { code?: number }) => {
      this.closeCurrentGeneration({ interrupted: false });
      this.rejectPendingGenerateReply();
      if (!this.closed && event.code !== WS_CLOSE_NORMAL) {
        this.emitError(new Error(`Phonic STS socket closed with code ${event.code ?? -1}`), false);
      }
    });

    await Promise.race([this.socket.waitForOpen(), this.closedFuture.await]);
    if (this.closed) {
      this.socket.close();
      return;
    }

    await this.instructionsReady.await;
    await this.toolsReady.await;
    if (this.closed) return;

    if (this.options.instructions === undefined) {
      this.emitError(
        new Error('Instructions are required to start a conversation with Phonic.'),
        false,
      );
      return;
    }

    this.configSent = true;
    this.socket.sendConfig({
      type: 'config',
      model: this.options.model as Phonic.ConfigPayload['model'],
      ...this.buildConfigOptions({
        systemPrompt: this.options.instructions + this.systemPromptPostfix,
        toolsPayload: [...(this.options.phonicTools ?? []), ...this.toolDefinitions],
      }),
    });
  }

  private handleServerMessage(message: ServerEvent): void {
    if (this.closed) {
      return;
    }

    switch (message.type) {
      case 'assistant_started_speaking':
        if (this.currentGeneration === undefined) {
          this.startNewAssistantTurn({ userInitiated: false });
        }
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
      case 'tool_call':
        this.handleToolCall(message);
        break;
      case 'error':
        this.emitError(new Error(message.error.message), false);
        break;
      case 'assistant_ended_conversation':
        this.emitError(
          new Error(
            'assistant_ended_conversation is not supported by the Phonic realtime model with LiveKit Agents.',
          ),
          false,
        );
        break;
      case 'conversation_created':
        this.conversationId = message.conversation_id;
        this.logger.info(`Phonic Conversation began with ID: ${this.conversationId}`);
        break;
      case 'tool_call_interrupted':
        this.handleToolCallInterrupted(message);
        break;
      case 'ready_to_start_conversation':
        this.readyToStart.resolve();
        break;
      case 'assistant_chose_not_to_respond':
      case 'input_cancelled':
      case 'tool_call_output_processed':
      case 'dtmf':
      default:
        break;
    }
  }

  private handleAudioChunk(message: Phonic.AudioChunkResponsePayload): void {
    /**
     * Although Phonic sends audio chunks when the assistant is not speaking (i.e. containing silence or background noise),
     * we only process the chunks when the assistant is speaking to align with the generations model, whereby new streams are created for each turn.
     */
    if (this.currentGeneration === undefined && message.text) {
      this.logger.debug('Starting new generation due to text in audio chunk');
      this.startNewAssistantTurn({ userInitiated: false });
    }

    const gen = this.currentGeneration;
    if (gen === undefined) return;

    if (message.text) {
      gen.outputText += message.text;
      gen.textChannel.write(message.text);
    }

    if (message.audio) {
      const bytes = Buffer.from(message.audio, 'base64');
      const sampleCount = Math.floor(bytes.byteLength / Int16Array.BYTES_PER_ELEMENT);
      if (sampleCount > 0) {
        const pcm = new Int16Array(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + sampleCount * Int16Array.BYTES_PER_ELEMENT,
          ),
        );
        const frame = new AudioFrame(
          pcm,
          PHONIC_OUTPUT_SAMPLE_RATE,
          PHONIC_NUM_CHANNELS,
          sampleCount / PHONIC_NUM_CHANNELS,
        );
        gen.audioChannel.write(frame);
      }
    }
  }

  private handleInputText(message: Phonic.InputTextPayload): void {
    const itemId = shortuuid('PI_');
    this.emit('input_audio_transcription_completed', {
      itemId,
      transcript: message.text,
      isFinal: true,
    });

    this._chatCtx.addMessage({
      role: 'user',
      content: message.text,
      id: itemId,
    });
  }

  private handleToolCall(message: Phonic.ToolCallPayload): void {
    this.pendingToolCallIds.add(message.tool_call_id);

    if (this.currentGeneration === undefined) {
      this.logger.warn('Encountered tool call but no active generation. Starting new turn.');
      this.startNewAssistantTurn({ userInitiated: false });
    }

    this.currentGeneration!.functionChannel.write(
      llm.FunctionCall.create({
        callId: message.tool_call_id,
        name: message.tool_name,
        args: JSON.stringify(message.parameters),
      }),
    );
    // At most 1 tool call is supported per turn due to `toolChaining: false`, allowing us to close the generation
    this.closeCurrentGeneration({ interrupted: false });
  }

  private handleToolCallInterrupted(message: Phonic.ToolCallInterruptedPayload): void {
    this.pendingToolCallIds.delete(message.tool_call_id);
    this.logger.warn(
      `Tool call for ${message.tool_name} (call_id: ${message.tool_call_id}) was cancelled due to user interruption.`,
    );
  }

  private handleInputSpeechStarted(): void {
    this.emit('input_speech_started', {});
    this.closeCurrentGeneration({ interrupted: true });
  }

  private handleInputSpeechStopped(): void {
    this.emit('input_speech_stopped', {
      userTranscriptionEnabled: true,
    });
  }

  private startNewAssistantTurn({
    userInitiated,
  }: {
    userInitiated: boolean;
  }): llm.GenerationCreatedEvent {
    if (this.currentGeneration) {
      this.closeCurrentGeneration({ interrupted: true });
    }

    const responseId = shortuuid('PS_');

    const textChannel = stream.createStreamChannel<string>();
    const audioChannel = stream.createStreamChannel<AudioFrame>();
    const functionChannel = stream.createStreamChannel<llm.FunctionCall>();
    const messageChannel = stream.createStreamChannel<llm.MessageGeneration>();

    messageChannel.write({
      messageId: responseId,
      textStream: textChannel.stream(),
      audioStream: audioChannel.stream(),
      modalities: Promise.resolve(['audio', 'text']),
    });

    this.currentGeneration = {
      responseId,
      messageChannel,
      functionChannel,
      textChannel,
      audioChannel,
      outputText: '',
    };

    const generationEvent: llm.GenerationCreatedEvent = {
      messageStream: messageChannel.stream(),
      functionStream: functionChannel.stream(),
      userInitiated,
      responseId,
    };

    if (this.pendingGenerateReplyFut && !this.pendingGenerateReplyFut.done) {
      generationEvent.userInitiated = true;
      this.pendingGenerateReplyFut.resolve(generationEvent);
      this.pendingGenerateReplyFut = undefined;
    }

    this.emit('generation_created', generationEvent);
    return generationEvent;
  }

  private finishAssistantTurn(): void {
    this.closeCurrentGeneration({ interrupted: false });
  }

  private closeCurrentGeneration({ interrupted }: { interrupted: boolean }): void {
    const gen = this.currentGeneration;
    if (!gen) return;

    if (gen.outputText) {
      this._chatCtx.addMessage({
        role: 'assistant',
        content: gen.outputText,
        id: gen.responseId,
        interrupted,
      });
    }

    gen.textChannel.close();
    gen.audioChannel.close();
    gen.functionChannel.close();
    gen.messageChannel.close();
    this.currentGeneration = undefined;
  }

  private rejectPendingGenerateReply(): void {
    if (this.pendingGenerateReplyFut && !this.pendingGenerateReplyFut.done) {
      this.pendingGenerateReplyFut.reject(new Error('session is closed'));
      this.pendingGenerateReplyFut = undefined;
    }
  }

  private emitError(error: Error, recoverable: boolean): void {
    this.emit('error', {
      timestamp: Date.now(),
      label: 'phonic_realtime',
      type: 'realtime_model_error',
      error,
      recoverable,
    } satisfies llm.RealtimeModelError);
  }

  private buildConfigOptions({
    systemPrompt,
    toolsPayload,
  }: {
    systemPrompt: string;
    toolsPayload: Phonic.ConfigOptions.Tools.Item[];
  }): Phonic.ConfigOptions {
    return {
      agent: this.options.phonicAgent,
      project: this.options.project,
      welcome_message: this.options.welcomeMessage,
      generate_welcome_message: this.options.generateWelcomeMessage,
      system_prompt: systemPrompt,
      voice_id: this.options.voice,
      input_format: 'pcm_44100',
      output_format: 'pcm_44100',
      ...(this.options.defaultLanguage !== undefined && {
        default_language: this.options.defaultLanguage,
      }),
      ...(this.options.additionalLanguages !== undefined && {
        additional_languages: this.options.additionalLanguages,
      }),
      ...(this.options.multilingualMode !== undefined && {
        multilingual_mode: this.options.multilingualMode,
      }),
      audio_speed: this.options.audioSpeed,
      tools: toolsPayload,
      boosted_keywords: this.options.boostedKeywords,
      // ...(this.options.minWordsToInterrupt !== undefined && {
      //   min_words_to_interrupt: this.options.minWordsToInterrupt,
      // }),
      generate_no_input_poke_text: this.options.generateNoInputPokeText,
      no_input_poke_sec: this.options.noInputPokeSec,
      no_input_poke_text: this.options.noInputPokeText,
      no_input_end_conversation_sec: this.options.noInputEndConversationSec,
    };
  }

  private buildTurnHistory(chatCtx: llm.ChatContext): string | undefined {
    const messages = chatCtx.items.filter(
      (item): item is llm.ChatMessage =>
        item.type === 'message' &&
        'textContent' in item &&
        item.textContent !== undefined &&
        item.textContent.trim() !== '',
    );
    if (messages.length === 0) return undefined;
    const history = messages.map((m) => `${m.role}: ${m.textContent}`).join('\n');
    return history.trim() || undefined;
  }

  private *resampleAudio(frame: AudioFrame): Generator<AudioFrame> {
    if (this.inputResampler) {
      if (frame.sampleRate !== this.inputResamplerInputRate) {
        this.inputResampler.close();
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
