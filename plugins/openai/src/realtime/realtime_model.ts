// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AsyncIterableQueue, Future, Queue, llm, log, mergeFrames, metrics } from '@livekit/agents';
import type { AudioResampler } from '@livekit/rtc-node';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import * as api_proto from './api_proto.js';

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const BASE_URL = 'https://api.openai.com/v1';

interface RealtimeOptions {
  model: api_proto.Model;
  voice: api_proto.Voice;
  temperature: number;
  toolChoice: llm.ToolChoice;
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
  textChannel: AsyncIterableQueue<string>;
  audioChannel: AsyncIterableQueue<AudioFrame>;
  audioTranscript: string;
}

interface ResponseGeneration {
  messageChannel: AsyncIterableQueue<llm.MessageGeneration>;
  functionChannel: AsyncIterableQueue<llm.FunctionCall>;
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
  #sessions: RealtimeSession[] = [];

  constructor(options: {
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
  }) {
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

  get sessions(): RealtimeSession[] {
    return this.#sessions;
  }

  session() {
    const session = new RealtimeSession(this);
    this.#sessions.push(session);
    return session;
  }

  async close() {
    await Promise.allSettled(this.#sessions.map((session) => session.close()));
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

  private itemCreateFutures: { [id: string]: Future } = {};
  private itemDeleteFutures: { [id: string]: Future } = {};

  private textModeRecoveryRetries: number = 0;

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
              this.#logger.debug(`-> ${JSON.stringify(this.#loggableEvent(event))}`);
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
        this.#logger.debug(`<- ${JSON.stringify(this.#loggableEvent(event))}`);
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
      messageChannel: new AsyncIterableQueue(),
      functionChannel: new AsyncIterableQueue(),
      messages: new Map(),
      _doneFut: new Future(),
      _createdTimestamp: Date.now(),
    };

    if (
      event.response.metadata &&
      typeof event.response.metadata === 'object' &&
      event.response.metadata['client_event_id']
    ) {
      const clientEventId = event.response.metadata['client_event_id'];
      const handle = this.responseCreatedFutures[clientEventId];

      // set key to the response id
      if (handle) {
        delete this.responseCreatedFutures[clientEventId];
        this.responseCreatedFutures[event.response.id] = handle;
      }
    }
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
      this.remoteChatCtx.insert(event.item.id, openAIItemToLivekitItem(event.item));
    } catch (error) {
      this.#logger.error({ error, itemId: event.item.id }, 'failed to insert conversation item');
    }

    const fut = this.itemCreateFutures[event.item.id];
    if (fut) {
      fut.resolve();
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
        textChannel: new AsyncIterableQueue(),
        audioChannel: new AsyncIterableQueue(),
        audioTranscript: '',
      };

      this.currentGeneration.messageChannel.put({
        messageId: itemId,
        textStream: itemGeneration.textChannel,
        audioStream: itemGeneration.audioChannel,
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
      itemGeneration.textChannel.put(delta);
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

    const data = Buffer.from(event.delta, 'base64');
    itemGeneration.audioChannel.put(
      new AudioFrame(
        new Int16Array(data.buffer),
        api_proto.SAMPLE_RATE,
        api_proto.NUM_CHANNELS,
        data.length / 2,
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
      this.currentGeneration.functionChannel.put({
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

    for (const generation of this.currentGeneration.messages.values()) {
      // close all messages that haven't been closed yet
      if (!generation.textChannel.closed) {
        generation.textChannel.close();
      }
      if (!generation.audioChannel.closed) {
        generation.audioChannel.close();
      }
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

  private emitGenerationEvent(responseId: string): void {
    if (!this.currentGeneration) {
      throw new Error('currentGeneration is not set');
    }

    const generation_ev = {
      messageStream: this.currentGeneration.messageChannel,
      functionStream: this.currentGeneration.functionChannel,
      userInitiated: false,
    } as llm.GenerationCreatedEvent;

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

    this.emit('generation_created', generation_ev);
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

function toOaiToolChoice(toolChoice: llm.ToolChoice | null): api_proto.ToolChoice {
  if (typeof toolChoice === 'string') {
    return toolChoice;
  }

  if (toolChoice?.type === 'function') {
    return toolChoice.function.name;
  }

  return 'auto';
}
