// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream, Future, Queue, llm, log, shortuuid, stream } from '@livekit/agents';
import { Mutex } from '@livekit/mutex';
import type { AudioResampler } from '@livekit/rtc-node';
import { AudioFrame, combineAudioFrames } from '@livekit/rtc-node';
import { delay } from '@std/async';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import * as api_proto from './api_proto.js';

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const BASE_URL = 'https://api.openai.com/v1';

const MOCK_AUDIO_ID_PREFIX = 'lk_mock_audio_item_';

interface RealtimeOptions {
  model: api_proto.Model;
  voice: api_proto.Voice;
  temperature: number;
  toolChoice?: llm.ToolChoice;
  inputAudioTranscription?: api_proto.InputAudioTranscription | null;
  // TODO(shubhra): add inputAudioNoiseReduction
  turnDetection?: api_proto.TurnDetectionType | null;
  maxResponseOutputTokens?: number | 'inf';
  speed?: number;
  // TODO(shubhra): add openai tracing options
  apiKey?: string;
  baseURL: string;
  isAzure: boolean;
  azureDeployment?: string;
  entraToken?: string;
  apiVersion?: string;
  maxSessionDuration?: number;
  // TODO(shubhra): add connOptions
}

interface MessageGeneration {
  messageId: string;
  textChannel: stream.StreamChannel<string>;
  audioChannel: stream.StreamChannel<AudioFrame>;
  audioTranscript: string;
}

interface ResponseGeneration {
  messageChannel: stream.StreamChannel<llm.MessageGeneration>;
  functionChannel: stream.StreamChannel<llm.FunctionCall>;
  messages: Map<string, MessageGeneration>;

  /** @internal */
  _doneFut: Future;
  /** @internal */
  _createdTimestamp: number;
  /** @internal */
  _firstTokenTimestamp?: number;
}

class CreateResponseHandle {
  instructions?: string;
  doneFut: Future<llm.GenerationCreatedEvent>;
  // TODO(shubhra): add timeout
  constructor({ instructions }: { instructions?: string }) {
    this.instructions = instructions;
    this.doneFut = new Future();
  }
}

// default values got from a "default" session from their API
const DEFAULT_TEMPERATURE = 0.8;
const DEFAULT_TURN_DETECTION: api_proto.TurnDetectionType = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 200,
  create_response: true,
  interrupt_response: true,
};
const DEFAULT_INPUT_AUDIO_TRANSCRIPTION: api_proto.InputAudioTranscription = {
  model: 'gpt-4o-mini-transcribe',
};
const DEFAULT_TOOL_CHOICE: llm.ToolChoice = 'auto';
const DEFAULT_MAX_RESPONSE_OUTPUT_TOKENS: number | 'inf' = 'inf';

const AZURE_DEFAULT_INPUT_AUDIO_TRANSCRIPTION: api_proto.InputAudioTranscription = {
  model: 'whisper-1',
};

const AZURE_DEFAULT_TURN_DETECTION: api_proto.TurnDetectionType = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 200,
  create_response: true,
};

const DEFAULT_MAX_SESSION_DURATION = 20 * 60 * 1000; // 20 minutes

const DEFAULT_REALTIME_MODEL_OPTIONS = {
  model: 'gpt-4o-realtime-preview',
  voice: 'alloy',
  temperature: DEFAULT_TEMPERATURE,
  inputAudioTranscription: DEFAULT_INPUT_AUDIO_TRANSCRIPTION,
  turnDetection: DEFAULT_TURN_DETECTION,
  toolChoice: DEFAULT_TOOL_CHOICE,
  maxResponseOutputTokens: DEFAULT_MAX_RESPONSE_OUTPUT_TOKENS,
  maxSessionDuration: DEFAULT_MAX_SESSION_DURATION,
};
export class RealtimeModel extends llm.RealtimeModel {
  sampleRate = api_proto.SAMPLE_RATE;
  numChannels = api_proto.NUM_CHANNELS;
  inFrameSize = api_proto.IN_FRAME_SIZE;
  outFrameSize = api_proto.OUT_FRAME_SIZE;

  /* @internal */
  _options: RealtimeOptions;

  constructor(
    options: {
      model?: string;
      voice?: string;
      temperature?: number;
      toolChoice?: llm.ToolChoice;
      baseURL?: string;
      inputAudioTranscription?: api_proto.InputAudioTranscription | null;
      // TODO(shubhra): add inputAudioNoiseReduction
      turnDetection?: api_proto.TurnDetectionType | null;
      speed?: number;
      // TODO(shubhra): add openai tracing options
      azureDeployment?: string;
      apiKey?: string;
      entraToken?: string;
      apiVersion?: string;
      maxSessionDuration?: number;
      // TODO(shubhra): add connOptions
    } = {},
  ) {
    super({
      messageTruncation: true,
      turnDetection: options.turnDetection !== null,
      userTranscription: options.inputAudioTranscription !== null,
      autoToolReplyGeneration: false,
    });

    const isAzure = !!(options.apiVersion || options.entraToken || options.azureDeployment);

    if (options.apiKey === '' && !isAzure) {
      throw new Error(
        'OpenAI API key is required, either using the argument or by setting the OPENAI_API_KEY environmental variable',
      );
    }

    const apiKey = options.apiKey || process.env.OPENAI_API_KEY;

    if (!apiKey && !isAzure) {
      throw new Error(
        'OpenAI API key is required, either using the argument or by setting the OPENAI_API_KEY environmental variable',
      );
    }

    if (!options.baseURL && isAzure) {
      const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
      if (!azureEndpoint) {
        throw new Error(
          'Missing Azure endpoint. Please pass base_url or set AZURE_OPENAI_ENDPOINT environment variable.',
        );
      }
      options.baseURL = `${azureEndpoint.replace(/\/$/, '')}/openai`;
    }

    this._options = {
      ...DEFAULT_REALTIME_MODEL_OPTIONS,
      ...options,
      baseURL: options.baseURL || BASE_URL,
      apiKey,
      isAzure,
      model: options.model || DEFAULT_REALTIME_MODEL_OPTIONS.model,
    };
  }

  /**
   * Create a RealtimeModel instance configured for Azure OpenAI Service.
   *
   * @param azureDeployment - The name of your Azure OpenAI deployment.
   * @param azureEndpoint - The endpoint URL for your Azure OpenAI resource. If undefined, will attempt to read from the environment variable AZURE_OPENAI_ENDPOINT.
   * @param apiVersion - API version to use with Azure OpenAI Service. If undefined, will attempt to read from the environment variable OPENAI_API_VERSION.
   * @param apiKey - Azure OpenAI API key. If undefined, will attempt to read from the environment variable AZURE_OPENAI_API_KEY.
   * @param entraToken - Azure Entra authentication token. Required if not using API key authentication.
   * @param baseURL - Base URL for the API endpoint. If undefined, constructed from the azure_endpoint.
   * @param voice - Voice setting for audio outputs. Defaults to "alloy".
   * @param inputAudioTranscription - Options for transcribing input audio. Defaults to @see DEFAULT_INPUT_AUDIO_TRANSCRIPTION.
   * @param turnDetection - Options for server-based voice activity detection (VAD). Defaults to @see DEFAULT_SERVER_VAD_OPTIONS.
   * @param temperature - Sampling temperature for response generation. Defaults to @see DEFAULT_TEMPERATURE.
   * @param speed - Speed of the audio output. Defaults to 1.0.
   * @param maxResponseOutputTokens - Maximum number of tokens in the response. Defaults to @see DEFAULT_MAX_RESPONSE_OUTPUT_TOKENS.
   * @param maxSessionDuration - Maximum duration of the session in milliseconds. Defaults to @see DEFAULT_MAX_SESSION_DURATION.
   *
   * @returns A RealtimeModel instance configured for Azure OpenAI Service.
   *
   * @throws Error if required Azure parameters are missing or invalid.
   */
  static withAzure({
    azureDeployment,
    azureEndpoint,
    apiVersion,
    apiKey,
    entraToken,
    baseURL,
    voice = 'alloy',
    inputAudioTranscription = AZURE_DEFAULT_INPUT_AUDIO_TRANSCRIPTION,
    turnDetection = AZURE_DEFAULT_TURN_DETECTION,
    temperature = 0.8,
    speed,
  }: {
    azureDeployment: string;
    azureEndpoint?: string;
    apiVersion?: string;
    apiKey?: string;
    entraToken?: string;
    baseURL?: string;
    voice?: string;
    inputAudioTranscription?: api_proto.InputAudioTranscription;
    // TODO(shubhra): add inputAudioNoiseReduction
    turnDetection?: api_proto.TurnDetectionType;
    temperature?: number;
    speed?: number;
  }) {
    apiKey = apiKey || process.env.AZURE_OPENAI_API_KEY;
    if (!apiKey && !entraToken) {
      throw new Error(
        'Missing credentials. Please pass one of `apiKey`, `entraToken`, or the `AZURE_OPENAI_API_KEY` environment variable.',
      );
    }

    apiVersion = apiVersion || process.env.OPENAI_API_VERSION;
    if (!apiVersion) {
      throw new Error(
        'Must provide either the `apiVersion` argument or the `OPENAI_API_VERSION` environment variable',
      );
    }

    if (!baseURL) {
      azureEndpoint = azureEndpoint || process.env.AZURE_OPENAI_ENDPOINT;
      if (!azureEndpoint) {
        throw new Error(
          'Missing Azure endpoint. Please pass the `azure_endpoint` parameter or set the `AZURE_OPENAI_ENDPOINT` environment variable.',
        );
      }
      baseURL = `${azureEndpoint.replace(/\/$/, '')}/openai`;
    }

    return new RealtimeModel({
      voice,
      inputAudioTranscription,
      turnDetection,
      temperature,
      speed,
      apiKey,
      azureDeployment,
      apiVersion,
      entraToken,
      baseURL,
    });
  }

  session() {
    return new RealtimeSession(this);
  }

  async close() {
    return;
  }
}

function processBaseURL({
  baseURL,
  model,
  isAzure = false,
  azureDeployment,
  apiVersion,
}: {
  baseURL: string;
  model: string;
  isAzure: boolean;
  azureDeployment?: string;
  apiVersion?: string;
}): string {
  const url = new URL([baseURL, 'realtime'].join('/'));

  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }

  // ensure "/realtime" is added if the path is empty OR "/v1"
  if (!url.pathname || ['', '/v1', '/openai'].includes(url.pathname.replace(/\/$/, ''))) {
    url.pathname = url.pathname.replace(/\/$/, '') + '/realtime';
  } else {
    url.pathname = url.pathname.replace(/\/$/, '');
  }

  const queryParams: Record<string, string> = {};
  if (isAzure) {
    if (apiVersion) {
      queryParams['api-version'] = apiVersion;
    }
    if (azureDeployment) {
      queryParams['deployment'] = azureDeployment;
    }
  } else {
    queryParams['model'] = model;
  }

  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

/**
 * A session for the OpenAI Realtime API.
 *
 * This class is used to interact with the OpenAI Realtime API.
 * It is responsible for sending events to the OpenAI Realtime API and receiving events from it.
 *
 * It exposes two more events:
 * - openai_server_event_received: expose the raw server events from the OpenAI Realtime API
 * - openai_client_event_queued: expose the raw client events sent to the OpenAI Realtime API
 */
export class RealtimeSession extends llm.RealtimeSession {
  private _tools: llm.ToolContext = {};
  private remoteChatCtx: llm.RemoteChatContext = new llm.RemoteChatContext();
  private messageChannel = new Queue<api_proto.ClientEvent>();
  private inputResampler?: AudioResampler;
  private instructions?: string;
  private oaiRealtimeModel: RealtimeModel;
  private currentGeneration?: ResponseGeneration;
  private responseCreatedFutures: { [id: string]: CreateResponseHandle } = {};

  private textModeRecoveryRetries: number = 0;

  private itemCreateFutures: { [id: string]: Future } = {};
  private itemDeleteFutures: { [id: string]: Future } = {};

  private updateChatCtxLock = new Mutex();
  private updateFuncCtxLock = new Mutex();

  // 100ms chunks
  private bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS, SAMPLE_RATE / 10);

  private pushedDurationMs: number = 0;

  #ws: WebSocket | null = null;
  #expiresAt: number | null = null;
  #logger = log();
  #task: Promise<void>;
  #closing = true;

  constructor(realtimeModel: RealtimeModel) {
    super(realtimeModel);

    this.oaiRealtimeModel = realtimeModel;

    this.#task = this.#start();

    this.sendEvent(this.createSessionUpdateEvent());
  }

  sendEvent(command: api_proto.ClientEvent): void {
    this.messageChannel.put(command);
  }

  private createSessionUpdateEvent(): api_proto.SessionUpdateEvent {
    return {
      type: 'session.update',
      session: {
        model: this.oaiRealtimeModel._options.model,
        voice: this.oaiRealtimeModel._options.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        modalities: ['text', 'audio'],
        turn_detection: this.oaiRealtimeModel._options.turnDetection,
        input_audio_transcription: this.oaiRealtimeModel._options.inputAudioTranscription,
        // TODO(shubhra): add inputAudioNoiseReduction
        temperature: this.oaiRealtimeModel._options.temperature,
        tool_choice: toOaiToolChoice(this.oaiRealtimeModel._options.toolChoice),
        max_response_output_tokens:
          this.oaiRealtimeModel._options.maxResponseOutputTokens === Infinity
            ? 'inf'
            : this.oaiRealtimeModel._options.maxResponseOutputTokens,
        // TODO(shubhra): add tracing options
        instructions: this.instructions,
        speed: this.oaiRealtimeModel._options.speed,
      },
    };
  }

  get chatCtx() {
    return this.remoteChatCtx.toChatCtx();
  }

  get tools() {
    return { ...this._tools } as llm.ToolContext;
  }

  async updateChatCtx(_chatCtx: llm.ChatContext): Promise<void> {
    const unlock = await this.updateChatCtxLock.lock();
    const events = this.createChatCtxUpdateEvents(_chatCtx);
    const futures: Future<void>[] = [];

    for (const event of events) {
      const future = new Future<void>();
      futures.push(future);

      if (event.type === 'conversation.item.create') {
        this.itemCreateFutures[event.item.id] = future;
      } else if (event.type == 'conversation.item.delete') {
        this.itemDeleteFutures[event.item_id] = future;
      }

      this.sendEvent(event);
    }

    if (futures.length === 0) {
      unlock();
      return;
    }

    try {
      // wait for futures to resolve or timeout
      await Promise.race([
        Promise.all(futures),
        delay(5000).then(() => {
          throw new Error('Chat ctx update events timed out');
        }),
      ]);
    } catch (e) {
      this.#logger.error((e as Error).message);
      throw e;
    } finally {
      unlock();
    }
  }

  private createChatCtxUpdateEvents(
    chatCtx: llm.ChatContext,
    addMockAudio: boolean = false,
  ): (api_proto.ConversationItemCreateEvent | api_proto.ConversationItemDeleteEvent)[] {
    const newChatCtx = chatCtx.copy();
    if (addMockAudio) {
      newChatCtx.items.push(createMockAudioItem());
    } else {
      // clean up existing mock audio items
      newChatCtx.items = newChatCtx.items.filter(
        (item) => !item.id.startsWith(MOCK_AUDIO_ID_PREFIX),
      );
    }

    const events: (
      | api_proto.ConversationItemCreateEvent
      | api_proto.ConversationItemDeleteEvent
    )[] = [];

    const diffOps = llm.computeChatCtxDiff(this.chatCtx, newChatCtx);
    for (const op of diffOps.toRemove) {
      events.push({
        type: 'conversation.item.delete',
        item_id: op,
        event_id: shortuuid('chat_ctx_delete_'),
      } as api_proto.ConversationItemDeleteEvent);
    }

    for (const [previousId, id] of diffOps.toCreate) {
      const chatItem = newChatCtx.getById(id);
      if (!chatItem) {
        throw new Error(`Chat item ${id} not found`);
      }
      events.push({
        type: 'conversation.item.create',
        item: livekitItemToOpenAIItem(chatItem),
        previous_item_id: previousId ?? undefined,
        event_id: shortuuid('chat_ctx_create_'),
      } as api_proto.ConversationItemCreateEvent);
    }
    return events;
  }

  async updateTools(_tools: llm.ToolContext): Promise<void> {
    const unlock = await this.updateFuncCtxLock.lock();
    const ev = this.createToolsUpdateEvent(_tools);
    this.sendEvent(ev);

    if (!ev.session.tools) {
      throw new Error('Tools are missing in the session update event');
    }

    // TODO(brian): these logics below are noops I think, leaving it here to keep
    // parity with the python but we should remove them later
    const retainedToolNames = new Set(ev.session.tools.map((tool) => tool.name));
    const retainedTools = Object.fromEntries(
      Object.entries(_tools).filter(
        ([name, tool]) => llm.isFunctionTool(tool) && retainedToolNames.has(name),
      ),
    );

    this._tools = retainedTools as llm.ToolContext;

    unlock();
  }

  private createToolsUpdateEvent(_tools: llm.ToolContext): api_proto.SessionUpdateEvent {
    const oaiTools: api_proto.Tool[] = [];

    for (const [name, tool] of Object.entries(_tools)) {
      if (!llm.isFunctionTool(tool)) {
        this.#logger.error({ name, tool }, "OpenAI Realtime API doesn't support this tool type");
        continue;
      }

      const { parameters: toolParameters, description } = tool;
      try {
        const parameters = llm.toJsonSchema(
          toolParameters,
        ) as unknown as api_proto.Tool['parameters'];

        oaiTools.push({
          name,
          description,
          parameters: parameters,
          type: 'function',
        });
      } catch (e) {
        this.#logger.error({ name, tool }, "OpenAI Realtime API doesn't support this tool type");
        continue;
      }
    }

    return {
      type: 'session.update',
      session: {
        model: this.oaiRealtimeModel._options.model,
        tools: oaiTools,
      },
      event_id: shortuuid('tools_update_'),
    };
  }

  async updateInstructions(_instructions: string): Promise<void> {
    const eventId = shortuuid('instructions_update_');
    this.sendEvent({
      type: 'session.update',
      session: {
        instructions: _instructions,
      },
      event_id: eventId,
    } as api_proto.SessionUpdateEvent);
    this.instructions = _instructions;
  }

  updateOptions({ toolChoice }: { toolChoice?: llm.ToolChoice }): void {
    const options: api_proto.SessionUpdateEvent['session'] = {};

    this.oaiRealtimeModel._options.toolChoice = toolChoice;
    options.tool_choice = toOaiToolChoice(toolChoice);

    // TODO(brian): add other options here

    this.sendEvent({
      type: 'session.update',
      session: options,
      event_id: shortuuid('options_update_'),
    });
  }

  pushAudio(frame: AudioFrame): void {
    for (const f of this.resampleAudio(frame)) {
      for (const nf of this.bstream.write(f.data.buffer)) {
        this.sendEvent({
          type: 'input_audio_buffer.append',
          audio: Buffer.from(nf.data.buffer).toString('base64'),
        } as api_proto.InputAudioBufferAppendEvent);
        // TODO(AJS-102): use frame.durationMs once available in rtc-node
        this.pushedDurationMs += (nf.samplesPerChannel / nf.sampleRate) * 1000;
      }
    }
  }

  async commitAudio(): Promise<void> {
    if (this.pushedDurationMs > 100) {
      // OpenAI requires at least 100ms of audio
      this.sendEvent({
        type: 'input_audio_buffer.commit',
      } as api_proto.InputAudioBufferCommitEvent);
      this.pushedDurationMs = 0;
    }
  }

  async clearAudio(): Promise<void> {
    this.sendEvent({
      type: 'input_audio_buffer.clear',
    } as api_proto.InputAudioBufferClearEvent);
    this.pushedDurationMs = 0;
  }

  async generateReply(instructions?: string): Promise<llm.GenerationCreatedEvent> {
    const handle = this.createResponse({ instructions, userInitiated: true });
    this.textModeRecoveryRetries = 0;
    return handle.doneFut.await;
  }

  async interrupt(): Promise<void> {
    this.sendEvent({
      type: 'response.cancel',
    } as api_proto.ResponseCancelEvent);
  }

  async truncate(_options: { messageId: string; audioEndMs: number }): Promise<void> {
    this.sendEvent({
      type: 'conversation.item.truncate',
      content_index: 0,
      item_id: _options.messageId,
      audio_end_ms: _options.audioEndMs,
    } as api_proto.ConversationItemTruncateEvent);
  }

  /// Truncates the data field of the event to the specified maxLength to avoid overwhelming logs
  /// with large amounts of base64 audio data.
  #loggableEvent(
    event: api_proto.ClientEvent | api_proto.ServerEvent,
    maxLength: number = 30,
  ): Record<string, unknown> {
    const untypedEvent: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      if (value !== undefined) {
        untypedEvent[key] = value;
      }
    }

    if (untypedEvent.audio && typeof untypedEvent.audio === 'string') {
      const truncatedData =
        untypedEvent.audio.slice(0, maxLength) + (untypedEvent.audio.length > maxLength ? '…' : '');
      return { ...untypedEvent, audio: truncatedData };
    }
    if (
      untypedEvent.delta &&
      typeof untypedEvent.delta === 'string' &&
      event.type === 'response.audio.delta'
    ) {
      const truncatedDelta =
        untypedEvent.delta.slice(0, maxLength) + (untypedEvent.delta.length > maxLength ? '…' : '');
      return { ...untypedEvent, delta: truncatedDelta };
    }
    return untypedEvent;
  }

  private createWsConn(): WebSocket {
    const headers: Record<string, string> = {
      'User-Agent': 'LiveKit-Agents-JS',
    };
    if (this.oaiRealtimeModel._options.isAzure) {
      // Microsoft API has two ways of authentication
      // 1. Entra token set as `Bearer` token
      // 2. API key set as `api_key` header (also accepts query string)
      if (this.oaiRealtimeModel._options.entraToken) {
        headers.Authorization = `Bearer ${this.oaiRealtimeModel._options.entraToken}`;
      } else if (this.oaiRealtimeModel._options.apiKey) {
        headers['api-key'] = this.oaiRealtimeModel._options.apiKey;
      } else {
        throw new Error('Microsoft API key or entraToken is required');
      }
    } else {
      headers.Authorization = `Bearer ${this.oaiRealtimeModel._options.apiKey}`;
      headers['OpenAI-Beta'] = 'realtime=v1';
    }
    const url = processBaseURL({
      baseURL: this.oaiRealtimeModel._options.baseURL,
      model: this.oaiRealtimeModel._options.model,
      isAzure: this.oaiRealtimeModel._options.isAzure,
      apiVersion: this.oaiRealtimeModel._options.apiVersion,
      azureDeployment: this.oaiRealtimeModel._options.azureDeployment,
    });
    this.#logger.debug(`Connecting to OpenAI Realtime API at ${url}`);
    const ws = new WebSocket(url, {
      headers: headers,
    });
    return ws;
  }

  #start(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      this.#ws = this.createWsConn();

      this.#ws.onerror = (error) => {
        reject(new Error('OpenAI Realtime WebSocket error: ' + error.message));
      };

      await once(this.#ws, 'open');
      this.#closing = false;

      const sendTask = async () => {
        while (this.#ws && !this.#closing && this.#ws.readyState === WebSocket.OPEN) {
          try {
            const event = await this.messageChannel.get();
            if (event.type !== 'input_audio_buffer.append') {
              this.#logger.debug(`(client) -> ${JSON.stringify(this.#loggableEvent(event))}`);
            }

            this.emit('openai_client_event_queued', event);
            this.#ws.send(JSON.stringify(event));
          } catch (error) {
            this.#logger.error('Error sending event:', error);
          }
        }
      };

      this.#ws.onmessage = (message) => {
        const event: api_proto.ServerEvent = JSON.parse(message.data as string);

        this.emit('openai_server_event_received', event);
        if (event.type !== 'response.audio.delta') {
          this.#logger.debug(`(server) <- ${JSON.stringify(this.#loggableEvent(event))}`);
        }

        switch (event.type) {
          case 'input_audio_buffer.speech_started':
            this.handleInputAudioBufferSpeechStarted(event);
            break;
          case 'input_audio_buffer.speech_stopped':
            this.handleInputAudioBufferSpeechStopped(event);
            break;
          case 'response.created':
            this.handleResponseCreated(event);
            break;
          case 'response.output_item.added':
            this.handleResponseOutputItemAdded(event);
            break;
          case 'conversation.item.created':
            this.handleConversationItemCreated(event);
            break;
          case 'conversation.item.deleted':
            this.handleConversationItemDeleted(event);
            break;
          case 'conversation.item.input_audio_transcription.completed':
            this.handleConversationItemInputAudioTranscriptionCompleted(event);
            break;
          case 'conversation.item.input_audio_transcription.failed':
            this.handleConversationItemInputAudioTranscriptionFailed(event);
            break;
          case 'response.content_part.added':
            this.handleResponseContentPartAdded(event);
            break;
          case 'response.content_part.done':
            this.handleResponseContentPartDone(event);
            break;
          case 'response.audio_transcript.delta':
            this.handleResponseAudioTranscriptDelta(event);
            break;
          case 'response.audio.delta':
            this.handleResponseAudioDelta(event);
            break;
          case 'response.audio_transcript.done':
            this.handleResponseAudioTranscriptDone(event);
            break;
          case 'response.audio.done':
            this.handleResponseAudioDone(event);
            break;
          case 'response.output_item.done':
            this.handleResponseOutputItemDone(event);
            break;
          case 'response.done':
            this.handleResponseDone(event);
            break;
          case 'error':
            this.handleError(event);
            break;
          default:
            this.#logger.debug(`unhandled event: ${event.type}`);
            break;
        }
      };

      sendTask();

      this.#ws.onclose = () => {
        if (this.#expiresAt && Date.now() >= this.#expiresAt * 1000) {
          this.#closing = true;
        }
        if (!this.#closing) {
          reject(new Error('OpenAI Realtime connection closed unexpectedly'));
        }
        this.#ws = null;
        resolve();
      };
    });
  }

  async close() {
    super.close();
    if (!this.#ws) return;
    this.#closing = true;
    this.#ws.close();
    await this.#task;
  }

  private handleInputAudioBufferSpeechStarted(
    _event: api_proto.InputAudioBufferSpeechStartedEvent,
  ): void {
    this.emit('input_speech_started', {} as llm.InputSpeechStartedEvent);
  }

  private handleInputAudioBufferSpeechStopped(
    _event: api_proto.InputAudioBufferSpeechStoppedEvent,
  ): void {
    this.emit('input_speech_stopped', {
      userTranscriptionEnabled: this.oaiRealtimeModel._options.inputAudioTranscription !== null,
    } as llm.InputSpeechStoppedEvent);
  }

  private handleResponseCreated(event: api_proto.ResponseCreatedEvent): void {
    if (!event.response.id) {
      throw new Error('response.id is missing');
    }

    this.currentGeneration = {
      messageChannel: stream.createStreamChannel<llm.MessageGeneration>(),
      functionChannel: stream.createStreamChannel<llm.FunctionCall>(),
      messages: new Map(),
      _doneFut: new Future(),
      _createdTimestamp: Date.now(),
    };

    if (!event.response.metadata || !event.response.metadata.client_event_id) return;

    const handle = this.responseCreatedFutures[event.response.metadata.client_event_id];
    if (!handle) return;

    delete this.responseCreatedFutures[event.response.metadata.client_event_id];

    // set key to the response id
    this.responseCreatedFutures[event.response.id] = handle;

    // the generation_created event is emitted when
    // 1. the response is not a message on response.output_item.added event
    // 2. the content is audio on response.content_part.added event
    // will try to recover from text response on response.content_part.done event
  }

  private handleResponseOutputItemAdded(event: api_proto.ResponseOutputItemAddedEvent): void {
    if (!this.currentGeneration) {
      throw new Error('currentGeneration is not set');
    }

    if (!event.item.type) {
      throw new Error('item.type is not set');
    }

    if (!event.response_id) {
      throw new Error('response_id is not set');
    }

    const itemType = event.item.type;
    const responseId = event.response_id;

    if (itemType !== 'message') {
      // emit immediately if it's not a message, otherwise wait response.content_part.added
      this.emitGenerationEvent(responseId);
      this.textModeRecoveryRetries = 0;
      return;
    }
  }

  private handleConversationItemCreated(event: api_proto.ConversationItemCreatedEvent): void {
    if (!event.item.id) {
      throw new Error('item.id is not set');
    }

    try {
      this.remoteChatCtx.insert(event.previous_item_id, openAIItemToLivekitItem(event.item));
    } catch (error) {
      this.#logger.error({ error, itemId: event.item.id }, 'failed to insert conversation item');
    }

    const fut = this.itemCreateFutures[event.item.id];
    if (fut) {
      fut.resolve();
      delete this.itemCreateFutures[event.item.id];
    }
  }

  private handleConversationItemDeleted(event: api_proto.ConversationItemDeletedEvent): void {
    if (!event.item_id) {
      throw new Error('item_id is not set');
    }

    try {
      this.remoteChatCtx.delete(event.item_id);
    } catch (error) {
      this.#logger.error({ error, itemId: event.item_id }, 'failed to delete conversation item');
    }

    const fut = this.itemDeleteFutures[event.item_id];
    if (fut) {
      fut.resolve();
      delete this.itemDeleteFutures[event.item_id];
    }
  }

  private handleConversationItemInputAudioTranscriptionCompleted(
    event: api_proto.ConversationItemInputAudioTranscriptionCompletedEvent,
  ): void {
    const remoteItem = this.remoteChatCtx.get(event.item_id);
    if (!remoteItem) {
      return;
    }

    const item = remoteItem.item;
    if (item instanceof llm.ChatMessage) {
      item.content.push(event.transcript);
    } else {
      throw new Error('item is not a chat message');
    }

    this.emit('input_audio_transcription_completed', {
      itemId: event.item_id,
      transcript: event.transcript,
      isFinal: true,
    } as llm.InputTranscriptionCompleted);
  }

  private handleConversationItemInputAudioTranscriptionFailed(
    event: api_proto.ConversationItemInputAudioTranscriptionFailedEvent,
  ): void {
    this.#logger.error(
      { error: event.error },
      'OpenAI Realtime API failed to transcribe input audio',
    );
  }

  private handleResponseContentPartAdded(event: api_proto.ResponseContentPartAddedEvent): void {
    if (!this.currentGeneration) {
      throw new Error('currentGeneration is not set');
    }

    const itemId = event.item_id;
    const itemType = event.part.type;
    const responseId = event.response_id;

    if (itemType === 'audio') {
      this.emitGenerationEvent(responseId);
      if (this.textModeRecoveryRetries > 0) {
        this.#logger.info(
          { retries: this.textModeRecoveryRetries },
          'recovered from text-only response',
        );
        this.textModeRecoveryRetries = 0;
      }

      const itemGeneration: MessageGeneration = {
        messageId: itemId,
        textChannel: stream.createStreamChannel<string>(),
        audioChannel: stream.createStreamChannel<AudioFrame>(),
        audioTranscript: '',
      };

      this.currentGeneration.messageChannel.write({
        messageId: itemId,
        textStream: itemGeneration.textChannel.stream(),
        audioStream: itemGeneration.audioChannel.stream(),
      });

      this.currentGeneration.messages.set(itemId, itemGeneration);
      this.currentGeneration._firstTokenTimestamp = Date.now();
      return;
    } else {
      this.interrupt();
      if (this.textModeRecoveryRetries === 0) {
        this.#logger.warn({ responseId }, 'received text-only response from OpenAI Realtime API');
      }
    }
  }

  private handleResponseContentPartDone(event: api_proto.ResponseContentPartDoneEvent): void {
    if (event.part.type !== 'text') {
      return;
    }

    if (!this.currentGeneration) {
      throw new Error('currentGeneration is not set');
    }

    // TODO(shubhra): handle text mode recovery
  }

  private handleResponseAudioTranscriptDelta(
    event: api_proto.ResponseAudioTranscriptDeltaEvent,
  ): void {
    if (!this.currentGeneration) {
      throw new Error('currentGeneration is not set');
    }

    const itemId = event.item_id;
    const delta = event.delta;

    // TODO (shubhra): add timed string support

    const itemGeneration = this.currentGeneration.messages.get(itemId);
    if (!itemGeneration) {
      throw new Error('itemGeneration is not set');
    } else {
      itemGeneration.textChannel.write(delta);
      itemGeneration.audioTranscript += delta;
    }
  }

  private handleResponseAudioDelta(event: api_proto.ResponseAudioDeltaEvent): void {
    if (!this.currentGeneration) {
      throw new Error('currentGeneration is not set');
    }

    const itemGeneration = this.currentGeneration.messages.get(event.item_id);
    if (!itemGeneration) {
      throw new Error('itemGeneration is not set');
    }

    const binaryString = atob(event.delta);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    itemGeneration.audioChannel.write(
      new AudioFrame(
        new Int16Array(bytes.buffer),
        api_proto.SAMPLE_RATE,
        api_proto.NUM_CHANNELS,
        bytes.length / 2,
      ),
    );
  }

  private handleResponseAudioTranscriptDone(
    _event: api_proto.ResponseAudioTranscriptDoneEvent,
  ): void {
    if (!this.currentGeneration) {
      throw new Error('currentGeneration is not set');
    }
  }

  private handleResponseAudioDone(_event: api_proto.ResponseAudioDoneEvent): void {
    if (!this.currentGeneration) {
      throw new Error('currentGeneration is not set');
    }
  }

  private handleResponseOutputItemDone(event: api_proto.ResponseOutputItemDoneEvent): void {
    if (!this.currentGeneration) {
      throw new Error('currentGeneration is not set');
    }

    const itemId = event.item.id;
    const itemType = event.item.type;

    if (itemType === 'function_call') {
      const item = event.item;
      if (!item.call_id || !item.name || !item.arguments) {
        throw new Error('item is not a function call');
      }
      this.currentGeneration.functionChannel.write({
        callId: item.call_id,
        name: item.name,
        args: item.arguments,
      } as llm.FunctionCall);
    } else if (itemType === 'message') {
      const itemGeneration = this.currentGeneration.messages.get(itemId);
      if (!itemGeneration) {
        return;
      }
      // text response doesn't have itemGeneration
      itemGeneration.textChannel.close();
      itemGeneration.audioChannel.close();
    }
  }

  private handleResponseDone(_event: api_proto.ResponseDoneEvent): void {
    if (!this.currentGeneration) {
      // OpenAI has a race condition where we could receive response.done without any
      // previous response.created (This happens generally during interruption)
      return;
    }

    this.#logger.debug(
      {
        messageCount: this.currentGeneration.messages.size,
      },
      'Closing generation channels in handleResponseDone',
    );

    for (const generation of this.currentGeneration.messages.values()) {
      generation.textChannel.close();
      generation.audioChannel.close();
    }

    this.currentGeneration.functionChannel.close();
    this.currentGeneration.messageChannel.close();

    for (const itemId of this.currentGeneration.messages.keys()) {
      const remoteItem = this.remoteChatCtx.get(itemId);
      if (remoteItem && remoteItem.item instanceof llm.ChatMessage) {
        remoteItem.item.content.push(this.currentGeneration.messages.get(itemId)!.audioTranscript);
      }
    }

    this.currentGeneration._doneFut.resolve();
    this.currentGeneration = undefined;

    // TODO(shubhra): calculate metrics
  }

  private handleError(event: api_proto.ErrorEvent): void {
    if (event.error.message.startsWith('Cancellation failed')) {
      return;
    }

    this.#logger.error({ error: event.error }, 'OpenAI Realtime API returned an error');
  }

  private *resampleAudio(frame: AudioFrame): Generator<AudioFrame> {
    yield frame;
  }

  private createResponse({
    userInitiated,
    instructions,
    oldHandle,
  }: {
    userInitiated: boolean;
    instructions?: string;
    oldHandle?: CreateResponseHandle;
  }): CreateResponseHandle {
    const handle = oldHandle || new CreateResponseHandle({ instructions });
    if (oldHandle && instructions) {
      handle.instructions = instructions;
    }

    const eventId = shortuuid('response_create_');
    if (userInitiated) {
      this.responseCreatedFutures[eventId] = handle;
    }

    const response: api_proto.ResponseCreateEvent['response'] = {};
    if (instructions) response.instructions = instructions;
    if (userInitiated) response.metadata = { client_event_id: eventId };

    this.sendEvent({
      type: 'response.create',
      event_id: eventId,
      response: Object.keys(response).length > 0 ? response : undefined,
    });

    return handle;
  }

  private emitGenerationEvent(responseId: string): void {
    if (!this.currentGeneration) {
      throw new Error('currentGeneration is not set');
    }

    const generation_ev: llm.GenerationCreatedEvent = {
      messageStream: this.currentGeneration.messageChannel.stream(),
      functionStream: this.currentGeneration.functionChannel.stream(),
      userInitiated: false,
    };

    const handle = this.responseCreatedFutures[responseId];
    if (handle) {
      delete this.responseCreatedFutures[responseId];
      generation_ev.userInitiated = true;
      if (handle.doneFut.done) {
        this.#logger.warn({ responseId }, 'response received after timeout');
      } else {
        handle.doneFut.resolve(generation_ev);
      }
    }

    this.#logger.debug({ responseId }, 'Emitting generation_created event');
    this.emit('generation_created', generation_ev);
  }
}

function livekitItemToOpenAIItem(item: llm.ChatItem): api_proto.ItemResource {
  switch (item.type) {
    case 'function_call':
      return {
        id: item.id,
        type: 'function_call',
        call_id: item.callId,
        name: item.name,
        arguments: item.args,
      } as api_proto.FunctionCallItem;
    case 'function_call_output':
      return {
        id: item.id,
        type: 'function_call_output',
        call_id: item.callId,
        output: item.output,
      } as api_proto.FunctionCallOutputItem;
    case 'message':
      const role = item.role === 'developer' ? 'system' : item.role;
      const contentList: api_proto.Content[] = [];
      for (const c of item.content) {
        if (typeof c === 'string') {
          contentList.push({
            type: role === 'assistant' ? 'text' : 'input_text',
            text: c,
          } as api_proto.InputTextContent);
        } else if (c.type === 'image_content') {
          // not supported for now
          continue;
        } else if (c.type === 'audio_content') {
          if (role === 'user') {
            const encodedAudio = Buffer.from(combineAudioFrames(c.frame).data).toString('base64');
            contentList.push({
              type: 'input_audio',
              audio: encodedAudio,
            } as api_proto.InputAudioContent);
          }
        }
      }
      return {
        id: item.id,
        type: 'message',
        role,
        content: contentList,
      } as api_proto.UserItem;
  }
}

function openAIItemToLivekitItem(item: api_proto.ItemResource): llm.ChatItem {
  if (!item.id) {
    throw new Error('item.id is not set');
  }

  switch (item.type) {
    case 'function_call':
      return llm.FunctionCall.create({
        id: item.id,
        callId: item.call_id,
        name: item.name,
        args: item.arguments,
      });
    case 'function_call_output':
      return llm.FunctionCallOutput.create({
        id: item.id,
        callId: item.call_id,
        output: item.output,
        isError: false,
      });
    case 'message':
      const content: llm.ChatContent[] = [];
      // item.content can be a single object or an array; normalize to array
      const contents = Array.isArray(item.content) ? item.content : [item.content];
      for (const c of contents) {
        if (c.type === 'text' || c.type === 'input_text') {
          content.push(c.text);
        }
      }
      return llm.ChatMessage.create({
        id: item.id,
        role: item.role,
        content,
      });
  }
}

function createMockAudioItem(durationSeconds: number = 2): llm.ChatMessage {
  const audioData = Buffer.alloc(durationSeconds * SAMPLE_RATE);
  return llm.ChatMessage.create({
    id: shortuuid(MOCK_AUDIO_ID_PREFIX),
    role: 'user',
    content: [
      {
        type: 'audio_content',
        frame: [
          new AudioFrame(
            new Int16Array(audioData.buffer),
            SAMPLE_RATE,
            NUM_CHANNELS,
            audioData.length / 2,
          ),
        ],
      } as llm.AudioContent,
    ],
  });
}

function toOaiToolChoice(toolChoice?: llm.ToolChoice): api_proto.ToolChoice {
  if (typeof toolChoice === 'string') {
    return toolChoice;
  }

  if (toolChoice?.type === 'function') {
    return toolChoice.function.name;
  }

  return 'auto';
}
