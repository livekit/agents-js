// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AsyncIterableQueue, Future, Queue, llm, log, mergeFrames, metrics } from '@livekit/agents';
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
  entraToken?: string;
  apiVersion?: string;
  maxSessionDuration?: number;
  // TODO(shubhra): add connOptions
}

export interface RealtimeResponse {
  id: string;
  status: api_proto.ResponseStatus;
  statusDetails: api_proto.ResponseStatusDetails | null;
  usage: api_proto.ModelUsage | null;
  output: RealtimeOutput[];
  doneFut: Future;
  createdTimestamp: number;
  firstTokenTimestamp?: number;
}

export interface RealtimeOutput {
  responseId: string;
  itemId: string;
  outputIndex: number;
  role: api_proto.Role;
  type: 'message' | 'function_call';
  content: RealtimeContent[];
  doneFut: Future;
}

export interface RealtimeContent {
  responseId: string;
  itemId: string;
  outputIndex: number;
  contentIndex: number;
  text: string;
  audio: AudioFrame[];
  textStream: AsyncIterableQueue<string>;
  audioStream: AsyncIterableQueue<AudioFrame>;
  toolCalls: RealtimeToolCall[];
  contentType: api_proto.Modality;
}

export interface RealtimeToolCall {
  name: string;
  arguments: string;
  toolCallID: string;
}

export interface InputSpeechTranscriptionCompleted {
  itemId: string;
  transcript: string;
}

export interface InputSpeechTranscriptionFailed {
  itemId: string;
  message: string;
}

export interface InputSpeechStarted {
  itemId: string;
}

export interface InputSpeechCommitted {
  itemId: string;
}

class InputAudioBuffer {
  #session: RealtimeSession;

  constructor(session: RealtimeSession) {
    this.#session = session;
  }

  append(frame: AudioFrame) {
    this.#session.queueMsg({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(frame.data.buffer).toString('base64'),
    });
  }

  clear() {
    this.#session.queueMsg({
      type: 'input_audio_buffer.clear',
    });
  }

  commit() {
    this.#session.queueMsg({
      type: 'input_audio_buffer.commit',
    });
  }
}

class ConversationItem {
  #session: RealtimeSession;
  #logger = log();

  constructor(session: RealtimeSession) {
    this.#session = session;
  }

  truncate(itemId: string, contentIndex: number, audioEnd: number) {
    this.#session.queueMsg({
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: contentIndex,
      audio_end_ms: audioEnd,
    });
  }

  delete(itemId: string) {
    this.#session.queueMsg({
      type: 'conversation.item.delete',
      item_id: itemId,
    });
  }

  create(message: llm.ChatItem, previousItemId?: string): void {
    if (message.type === 'message' && !message.content) {
      return;
    }

    let event: api_proto.ConversationItemCreateEvent | undefined = undefined;

    if (message.type === 'function_call_output') {
      const { callId: call_id, output } = message;
      if (typeof output !== 'string') {
        throw new TypeError('message.output must be a string');
      }

      event = {
        type: 'conversation.item.create',
        previous_item_id: previousItemId,
        item: {
          type: 'function_call_output',
          call_id,
          output,
        },
      };
    } else if (message.type === 'message') {
      let content = message.content;
      if (!Array.isArray(content)) {
        content = [content];
      }

      if (message.role === 'user') {
        const contents: (api_proto.InputTextContent | api_proto.InputAudioContent)[] = [];
        for (const c of content) {
          if (typeof c === 'string') {
            contents.push({
              type: 'input_text',
              text: c,
            });
          } else if (
            // typescript type guard for determining ChatAudio vs ChatImage
            ((c: llm.AudioContent | llm.ImageContent): c is llm.AudioContent => {
              return (c as llm.AudioContent).frame !== undefined;
            })(c)
          ) {
            contents.push({
              type: 'input_audio',
              audio: Buffer.from(mergeFrames(c.frame).data.buffer).toString('base64'),
            });
          }
        }

        event = {
          type: 'conversation.item.create',
          previous_item_id: previousItemId,
          item: {
            type: 'message',
            role: 'user',
            content: contents,
          },
        };
      } else if (message.role === 'assistant') {
        const contents: api_proto.TextContent[] = [];
        for (const c of content) {
          if (typeof c === 'string') {
            contents.push({
              type: 'text',
              text: c,
            });
          } else if (
            // typescript type guard for determining ChatAudio vs ChatImage
            ((c: llm.AudioContent | llm.ImageContent): c is llm.AudioContent => {
              return (c as llm.AudioContent).frame !== undefined;
            })(c)
          ) {
            this.#logger.warn('audio content in assistant message is not supported');
          }
        }

        event = {
          type: 'conversation.item.create',
          previous_item_id: previousItemId,
          item: {
            type: 'message',
            role: 'assistant',
            content: contents,
          },
        };
      } else if (message.role === 'system') {
        const contents: api_proto.InputTextContent[] = [];
        for (const c of content) {
          if (typeof c === 'string') {
            contents.push({
              type: 'input_text',
              text: c,
            });
          } else if (
            // typescript type guard for determining ChatAudio vs ChatImage
            ((c: llm.AudioContent | llm.ImageContent): c is llm.AudioContent => {
              return (c as llm.AudioContent).frame !== undefined;
            })(c)
          ) {
            this.#logger.warn('audio content in system message is not supported');
          }
        }

        event = {
          type: 'conversation.item.create',
          previous_item_id: previousItemId,
          item: {
            type: 'message',
            role: 'system',
            content: contents,
          },
        };
      } else {
        this.#logger
          .child({ message })
          .warn('chat message is not supported inside the realtime API');
        return;
      }
    }

    if (event) {
      this.#session.queueMsg(event);
    }
  }
}

class Conversation {
  #session: RealtimeSession;

  constructor(session: RealtimeSession) {
    this.#session = session;
  }

  get item(): ConversationItem {
    return new ConversationItem(this.#session);
  }
}

class Response {
  #session: RealtimeSession;

  constructor(session: RealtimeSession) {
    this.#session = session;
  }

  create() {
    this.#session.queueMsg({
      type: 'response.create',
    });
  }

  cancel() {
    this.#session.queueMsg({
      type: 'response.cancel',
    });
  }
}

interface ContentPtr {
  response_id: string;
  output_index: number;
  content_index: number;
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

  session(): RealtimeSession {
    const session = new RealtimeSession(this);
    this.#sessions.push(session);
    return session;
  }

  async close() {
    await Promise.allSettled(this.#sessions.map((session) => session.close()));
  }
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
  #chatCtx: llm.ChatContext | undefined = undefined;
  #toolCtx: llm.ToolContext | undefined = undefined;
  #opts: RealtimeOptions;
  #pendingResponses: { [id: string]: RealtimeResponse } = {};
  #sessionId = 'not-connected';
  #ws: WebSocket | null = null;
  #expiresAt: number | null = null;
  #logger = log();
  #task: Promise<void>;
  #closing = true;
  #sendQueue = new Queue<api_proto.ClientEvent>();

  constructor(
    opts: RealtimeOptions,
    { toolCtx, chatCtx }: { toolCtx?: llm.ToolContext; chatCtx?: llm.ChatContext },
  ) {
    super();

    this.#opts = opts;
    this.#chatCtx = chatCtx;
    this.#toolCtx = toolCtx;

    this.#task = this.#start();

    this.sessionUpdate({
      modalities: this.#opts.modalities,
      instructions: this.#opts.instructions,
      voice: this.#opts.voice,
      inputAudioFormat: this.#opts.inputAudioFormat,
      outputAudioFormat: this.#opts.outputAudioFormat,
      inputAudioTranscription: this.#opts.inputAudioTranscription,
      turnDetection: this.#opts.turnDetection,
      temperature: this.#opts.temperature,
      maxResponseOutputTokens: this.#opts.maxResponseOutputTokens,
      toolChoice: 'auto',
    });
  }

  get chatCtx(): llm.ChatContext | undefined {
    return this.#chatCtx;
  }

  get toolCtx(): llm.ToolContext | undefined {
    return this.#toolCtx;
  }

  set toolCtx(ctx: llm.ToolContext | undefined) {
    this.#toolCtx = ctx;
  }

  get conversation(): Conversation {
    return new Conversation(this);
  }

  get inputAudioBuffer(): InputAudioBuffer {
    return new InputAudioBuffer(this);
  }

  get response(): Response {
    return new Response(this);
  }

  get expiration(): number {
    if (!this.#expiresAt) {
      throw new Error('session not started');
    }
    return this.#expiresAt * 1000;
  }

  queueMsg(command: api_proto.ClientEvent): void {
    this.#sendQueue.put(command);
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

  sessionUpdate({
    modalities = this.#opts.modalities,
    instructions = this.#opts.instructions,
    voice = this.#opts.voice,
    inputAudioFormat = this.#opts.inputAudioFormat,
    outputAudioFormat = this.#opts.outputAudioFormat,
    inputAudioTranscription = this.#opts.inputAudioTranscription,
    turnDetection = this.#opts.turnDetection,
    temperature = this.#opts.temperature,
    maxResponseOutputTokens = this.#opts.maxResponseOutputTokens,
    toolChoice = 'auto',
    selectedTools = Object.keys(this.#toolCtx || {}),
  }: {
    modalities: ['text', 'audio'] | ['text'];
    instructions?: string;
    voice?: api_proto.Voice;
    inputAudioFormat?: api_proto.AudioFormat;
    outputAudioFormat?: api_proto.AudioFormat;
    inputAudioTranscription?: api_proto.InputAudioTranscription | null;
    turnDetection?: api_proto.TurnDetectionType | null;
    temperature?: number;
    maxResponseOutputTokens?: number;
    toolChoice?: api_proto.ToolChoice;
    selectedTools?: string[];
  }) {
    this.#opts = {
      modalities,
      instructions,
      voice,
      inputAudioFormat,
      outputAudioFormat,
      inputAudioTranscription,
      turnDetection,
      temperature,
      maxResponseOutputTokens,
      model: this.#opts.model,
      apiKey: this.#opts.apiKey,
      baseURL: this.#opts.baseURL,
      isAzure: this.#opts.isAzure,
      apiVersion: this.#opts.apiVersion,
      entraToken: this.#opts.entraToken,
    };

    const tools = this.#toolCtx
      ? Object.entries(this.#toolCtx)
          .filter(([name]) => selectedTools.includes(name))
          .map(([name, func]) => ({
            type: 'function' as const,
            name,
            description: func.description,
            parameters: llm.oaiParams(func.parameters),
          }))
      : [];

    const sessionUpdateEvent: api_proto.SessionUpdateEvent = {
      type: 'session.update',
      session: {
        modalities: this.#opts.modalities,
        instructions: this.#opts.instructions,
        voice: this.#opts.voice,
        input_audio_format: this.#opts.inputAudioFormat,
        output_audio_format: this.#opts.outputAudioFormat,
        input_audio_transcription: this.#opts.inputAudioTranscription,
        turn_detection: this.#opts.turnDetection,
        temperature: this.#opts.temperature,
        max_response_output_tokens:
          this.#opts.maxResponseOutputTokens === Infinity
            ? 'inf'
            : this.#opts.maxResponseOutputTokens,
        tools,
        tool_choice: toolChoice,
      },
    };

    if (this.#opts.isAzure && this.#opts.maxResponseOutputTokens === Infinity) {
      // microsoft doesn't support inf for max_response_output_tokens, but accepts no args
      sessionUpdateEvent.session.max_response_output_tokens = undefined;
    }

    this.queueMsg(sessionUpdateEvent);
  }

  /** Create an empty audio message with the given duration. */
  #createEmptyUserAudioMessage(duration: number): llm.ChatMessage {
    const samples = duration * api_proto.SAMPLE_RATE;
    return llm.ChatMessage.create({
      role: 'user',
      content: [
        {
          type: 'audio_content',
          frame: [
            new AudioFrame(
              new Int16Array(samples * api_proto.NUM_CHANNELS),
              api_proto.SAMPLE_RATE,
              api_proto.NUM_CHANNELS,
              samples,
            ),
          ],
        },
      ],
    });
  }

  /**
   * Try to recover from a text response to audio mode.
   *
   * @remarks
   * Sometimes the OpenAI Realtime API returns text instead of audio responses.
   * This method tries to recover from this by requesting a new response after deleting the text
   * response and creating an empty user audio message.
   */
  recoverFromTextResponse(itemId: string) {
    if (itemId) {
      this.conversation.item.delete(itemId);
    }
    this.conversation.item.create(this.#createEmptyUserAudioMessage(1));
    this.response.create();
  }

  #start(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const headers: Record<string, string> = {
        'User-Agent': 'LiveKit-Agents-JS',
      };
      if (this.#opts.isAzure) {
        // Microsoft API has two ways of authentication
        // 1. Entra token set as `Bearer` token
        // 2. API key set as `api_key` header (also accepts query string)
        if (this.#opts.entraToken) {
          headers.Authorization = `Bearer ${this.#opts.entraToken}`;
        } else if (this.#opts.apiKey) {
          headers['api-key'] = this.#opts.apiKey;
        } else {
          reject(new Error('Microsoft API key or entraToken is required'));
          return;
        }
      } else {
        headers.Authorization = `Bearer ${this.#opts.apiKey}`;
        headers['OpenAI-Beta'] = 'realtime=v1';
      }
      const url = new URL([this.#opts.baseURL, 'realtime'].join('/'));
      if (url.protocol === 'https:') {
        url.protocol = 'wss:';
      }

      // Construct query parameters
      const queryParams: Record<string, string> = {};
      if (this.#opts.isAzure) {
        queryParams['api-version'] = this.#opts.apiVersion ?? '2024-10-01-preview';
        queryParams['deployment'] = this.#opts.model;
      } else {
        queryParams['model'] = this.#opts.model;
      }

      for (const [key, value] of Object.entries(queryParams)) {
        url.searchParams.set(key, value);
      }

      console.debug('Connecting to OpenAI Realtime API at ', url.toString());
      this.#ws = new WebSocket(url.toString(), {
        headers: headers,
      });

      this.#ws.onerror = (error) => {
        reject(new Error('OpenAI Realtime WebSocket error: ' + error.message));
      };

      await once(this.#ws, 'open');
      this.#closing = false;

      this.#ws.onmessage = (message) => {
        const event: api_proto.ServerEvent = JSON.parse(message.data as string);
        this.#logger.debug(`<- ${JSON.stringify(this.#loggableEvent(event))}`);
        switch (event.type) {
          case 'error':
            this.#handleError(event);
            break;
          case 'session.created':
            this.#handleSessionCreated(event);
            break;
          case 'session.updated':
            this.#handleSessionUpdated(event);
            break;
          case 'conversation.created':
            this.#handleConversationCreated(event);
            break;
          case 'input_audio_buffer.committed':
            this.#handleInputAudioBufferCommitted(event);
            break;
          case 'input_audio_buffer.cleared':
            this.#handleInputAudioBufferCleared(event);
            break;
          case 'input_audio_buffer.speech_started':
            this.#handleInputAudioBufferSpeechStarted(event);
            break;
          case 'input_audio_buffer.speech_stopped':
            this.#handleInputAudioBufferSpeechStopped(event);
            break;
          case 'conversation.item.created':
            this.#handleConversationItemCreated(event);
            break;
          case 'conversation.item.input_audio_transcription.completed':
            this.#handleConversationItemInputAudioTranscriptionCompleted(event);
            break;
          case 'conversation.item.input_audio_transcription.failed':
            this.#handleConversationItemInputAudioTranscriptionFailed(event);
            break;
          case 'conversation.item.truncated':
            this.#handleConversationItemTruncated(event);
            break;
          case 'conversation.item.deleted':
            this.#handleConversationItemDeleted(event);
            break;
          case 'response.created':
            this.#handleResponseCreated(event);
            break;
          case 'response.done':
            this.#handleResponseDone(event);
            break;
          case 'response.output_item.added':
            this.#handleResponseOutputItemAdded(event);
            break;
          case 'response.output_item.done':
            this.#handleResponseOutputItemDone(event);
            break;
          case 'response.content_part.added':
            this.#handleResponseContentPartAdded(event);
            break;
          case 'response.content_part.done':
            this.#handleResponseContentPartDone(event);
            break;
          case 'response.text.delta':
            this.#handleResponseTextDelta(event);
            break;
          case 'response.text.done':
            this.#handleResponseTextDone(event);
            break;
          case 'response.audio_transcript.delta':
            this.#handleResponseAudioTranscriptDelta(event);
            break;
          case 'response.audio_transcript.done':
            this.#handleResponseAudioTranscriptDone(event);
            break;
          case 'response.audio.delta':
            this.#handleResponseAudioDelta(event);
            break;
          case 'response.audio.done':
            this.#handleResponseAudioDone(event);
            break;
          case 'response.function_call_arguments.delta':
            this.#handleResponseFunctionCallArgumentsDelta(event);
            break;
          case 'response.function_call_arguments.done':
            this.#handleResponseFunctionCallArgumentsDone(event);
            break;
          case 'rate_limits.updated':
            this.#handleRateLimitsUpdated(event);
            break;
        }
      };

      const sendTask = async () => {
        while (this.#ws && !this.#closing && this.#ws.readyState === WebSocket.OPEN) {
          try {
            const event = await this.#sendQueue.get();
            if (event.type !== 'input_audio_buffer.append') {
              this.#logger.debug(`-> ${JSON.stringify(this.#loggableEvent(event))}`);
            }
            this.#ws.send(JSON.stringify(event));
          } catch (error) {
            this.#logger.error('Error sending event:', error);
          }
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

  #getContent(ptr: ContentPtr): RealtimeContent {
    const response = this.#pendingResponses[ptr.response_id];
    const output = response!.output[ptr.output_index];
    const content = output!.content[ptr.content_index]!;
    return content;
  }

  #handleError(event: api_proto.ErrorEvent): void {
    this.#logger.error(`OpenAI Realtime error ${JSON.stringify(event.error)}`);
  }

  #handleSessionCreated(event: api_proto.SessionCreatedEvent): void {
    this.#sessionId = event.session.id;
    this.#expiresAt = event.session.expires_at;
    this.#logger = this.#logger.child({ sessionId: this.#sessionId });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #handleSessionUpdated(event: api_proto.SessionUpdatedEvent): void {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #handleConversationCreated(event: api_proto.ConversationCreatedEvent): void {}

  #handleInputAudioBufferCommitted(event: api_proto.InputAudioBufferCommittedEvent): void {
    this.emit('input_speech_committed', {
      itemId: event.item_id,
    } as InputSpeechCommitted);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #handleInputAudioBufferCleared(event: api_proto.InputAudioBufferClearedEvent): void {}

  #handleInputAudioBufferSpeechStarted(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    event: api_proto.InputAudioBufferSpeechStartedEvent,
  ): void {
    this.emit('input_speech_started', {
      itemId: event.item_id,
    } as InputSpeechStarted);
  }

  #handleInputAudioBufferSpeechStopped(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    event: api_proto.InputAudioBufferSpeechStoppedEvent,
  ): void {
    this.emit('input_speech_stopped');
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #handleConversationItemCreated(event: api_proto.ConversationItemCreatedEvent): void {}

  #handleConversationItemInputAudioTranscriptionCompleted(
    event: api_proto.ConversationItemInputAudioTranscriptionCompletedEvent,
  ): void {
    const transcript = event.transcript;
    this.emit('input_speech_transcription_completed', {
      itemId: event.item_id,
      transcript: transcript,
    } as InputSpeechTranscriptionCompleted);
  }

  #handleConversationItemInputAudioTranscriptionFailed(
    event: api_proto.ConversationItemInputAudioTranscriptionFailedEvent,
  ): void {
    const error = event.error;
    this.#logger.error(`OpenAI Realtime failed to transcribe input audio: ${error.message}`);
    this.emit('input_speech_transcription_failed', {
      itemId: event.item_id,
      message: error.message,
    } as InputSpeechTranscriptionFailed);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #handleConversationItemTruncated(event: api_proto.ConversationItemTruncatedEvent): void {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #handleConversationItemDeleted(event: api_proto.ConversationItemDeletedEvent): void {}

  #handleResponseCreated(responseCreated: api_proto.ResponseCreatedEvent): void {
    const response = responseCreated.response;
    const doneFut = new Future();
    const newResponse: RealtimeResponse = {
      id: response.id,
      status: response.status,
      statusDetails: response.status_details,
      usage: null,
      output: [],
      doneFut: doneFut,
      createdTimestamp: Date.now(),
    };
    this.#pendingResponses[newResponse.id] = newResponse;
    this.emit('response_created', newResponse);
  }

  #handleResponseDone(event: api_proto.ResponseDoneEvent): void {
    const responseData = event.response;
    const responseId = responseData.id;
    const response = this.#pendingResponses[responseId]!;
    response.status = responseData.status;
    response.statusDetails = responseData.status_details;
    response.usage = responseData.usage ?? null;
    this.#pendingResponses[responseId] = response;
    response.doneFut.resolve();

    let metricsError: Error | undefined;
    let cancelled = false;
    switch (response.status) {
      case 'failed': {
        if (response.statusDetails.type !== 'failed') break;
        const err = response.statusDetails.error;
        metricsError = new metrics.MultimodalLLMError({
          type: response.statusDetails.type,
          code: err?.code,
          message: err?.message,
        });
        this.#logger
          .child({ code: err?.code, error: err?.message })
          .error('response generation failed');
        break;
      }
      case 'incomplete': {
        if (response.statusDetails.type !== 'incomplete') break;
        const reason = response.statusDetails.reason;
        metricsError = new metrics.MultimodalLLMError({
          type: response.statusDetails.type,
          reason,
        });
        this.#logger.child({ reason }).error('response generation incomplete');
        break;
      }
      case 'cancelled': {
        cancelled = true;
        break;
      }
    }
    this.emit('response_done', response);

    let ttft: number | undefined;
    if (response.firstTokenTimestamp) {
      ttft = response.firstTokenTimestamp - response.createdTimestamp;
    }
    const duration = Date.now() - response.createdTimestamp;

    const usage = response.usage;
    const metric: metrics.MultimodalLLMMetrics = {
      timestamp: response.createdTimestamp,
      requestId: response.id,
      ttft: ttft!,
      duration,
      cancelled,
      label: this.constructor.name,
      completionTokens: usage?.output_tokens || 0,
      promptTokens: usage?.input_tokens || 0,
      totalTokens: usage?.total_tokens || 0,
      tokensPerSecond: ((usage?.output_tokens || 0) / duration) * 1000,
      error: metricsError,
      inputTokenDetails: {
        cachedTokens: usage?.input_token_details.cached_tokens || 0,
        textTokens: usage?.input_token_details.text_tokens || 0,
        audioTokens: usage?.input_token_details.audio_tokens || 0,
      },
      outputTokenDetails: {
        textTokens: usage?.output_token_details.text_tokens || 0,
        audioTokens: usage?.output_token_details.audio_tokens || 0,
      },
    };
    this.emit('metrics_collected', metric);
  }

  #handleResponseOutputItemAdded(event: api_proto.ResponseOutputItemAddedEvent): void {
    const responseId = event.response_id;
    const response = this.#pendingResponses[responseId];
    const itemData = event.item;

    if (itemData.type !== 'message' && itemData.type !== 'function_call') {
      throw new Error(`Unexpected item type: ${itemData.type}`);
    }

    let role: api_proto.Role;
    if (itemData.type === 'function_call') {
      role = 'assistant'; // function_call doesn't have a role field, defaulting it to assistant
    } else {
      role = itemData.role;
    }

    const newOutput: RealtimeOutput = {
      responseId: responseId,
      itemId: itemData.id,
      outputIndex: event.output_index,
      type: itemData.type,
      role: role,
      content: [],
      doneFut: new Future(),
    };
    response?.output.push(newOutput);
    this.emit('response_output_added', newOutput);
  }

  #handleResponseOutputItemDone(event: api_proto.ResponseOutputItemDoneEvent): void {
    const responseId = event.response_id;
    const response = this.#pendingResponses[responseId];
    const outputIndex = event.output_index;
    const output = response!.output[outputIndex];

    if (output?.type === 'function_call') {
      if (!this.#toolCtx) {
        this.#logger.error('function call received but no toolCtx is available');
        return;
      }

      // parse the arguments and call the function inside the fnc_ctx
      const item = event.item;
      if (item.type !== 'function_call') {
        throw new Error('Expected function_call item');
      }
      const func = this.#toolCtx[item.name];
      if (!func) {
        this.#logger.error(`no function with name ${item.name} in toolCtx`);
        return;
      }

      this.emit('function_call_started', {
        callId: item.call_id,
      });

      const parsedArgs = JSON.parse(item.arguments);

      this.#logger.debug(
        `[Function Call ${item.call_id}] Executing ${item.name} with arguments ${parsedArgs}`,
      );

      func
        .execute(parsedArgs, {
          ctx: {} as any, // TODO: provide proper RunContext
          toolCallId: item.call_id,
        })
        .then(
          (content) => {
            this.#logger.debug(`[Function Call ${item.call_id}] ${item.name} returned ${content}`);
            this.emit('function_call_completed', {
              callId: item.call_id,
            });
            this.conversation.item.create(
              llm.FunctionCallOutput.create({
                callId: item.call_id,
                output: content,
                isError: false,
              }),
              output.itemId,
            );
            this.response.create();
          },
          (error) => {
            this.#logger.error(`[Function Call ${item.call_id}] ${item.name} failed with ${error}`);
            // TODO: send it back up as failed?
            this.emit('function_call_failed', {
              callId: item.call_id,
            });
          },
        );
    }

    output?.doneFut.resolve();
    this.emit('response_output_done', output);
  }

  #handleResponseContentPartAdded(event: api_proto.ResponseContentPartAddedEvent): void {
    const responseId = event.response_id;
    const response = this.#pendingResponses[responseId];
    const outputIndex = event.output_index;
    const output = response!.output[outputIndex];

    const textStream = new AsyncIterableQueue<string>();
    const audioStream = new AsyncIterableQueue<AudioFrame>();

    const newContent: RealtimeContent = {
      responseId: responseId,
      itemId: event.item_id,
      outputIndex: outputIndex,
      contentIndex: event.content_index,
      text: '',
      audio: [],
      textStream: textStream,
      audioStream: audioStream,
      toolCalls: [],
      contentType: event.part.type,
    };
    output?.content.push(newContent);
    response!.firstTokenTimestamp = Date.now();
    this.emit('response_content_added', newContent);
  }

  #handleResponseContentPartDone(event: api_proto.ResponseContentPartDoneEvent): void {
    const content = this.#getContent(event);
    this.emit('response_content_done', content);
  }

  #handleResponseTextDelta(event: api_proto.ResponseTextDeltaEvent): void {
    this.emit('response_text_delta', event);
  }

  #handleResponseTextDone(event: api_proto.ResponseTextDoneEvent): void {
    const content = this.#getContent(event);
    content.text = event.text;
    this.emit('response_text_done', event);
  }

  #handleResponseAudioTranscriptDelta(event: api_proto.ResponseAudioTranscriptDeltaEvent): void {
    const content = this.#getContent(event);
    const transcript = event.delta;
    content.text += transcript;

    content.textStream.put(transcript);
  }

  #handleResponseAudioTranscriptDone(event: api_proto.ResponseAudioTranscriptDoneEvent): void {
    const content = this.#getContent(event);
    content.textStream.close();
  }

  #handleResponseAudioDelta(event: api_proto.ResponseAudioDeltaEvent): void {
    const content = this.#getContent(event);
    const data = Buffer.from(event.delta, 'base64');
    const audio = new AudioFrame(
      new Int16Array(data.buffer),
      api_proto.SAMPLE_RATE,
      api_proto.NUM_CHANNELS,
      data.length / 2,
    );
    content.audio.push(audio);

    content.audioStream.put(audio);
  }

  #handleResponseAudioDone(event: api_proto.ResponseAudioDoneEvent): void {
    const content = this.#getContent(event);
    content.audioStream.close();
  }

  #handleResponseFunctionCallArgumentsDelta(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    event: api_proto.ResponseFunctionCallArgumentsDeltaEvent,
  ): void {}

  #handleResponseFunctionCallArgumentsDone(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    event: api_proto.ResponseFunctionCallArgumentsDoneEvent,
  ): void {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #handleRateLimitsUpdated(event: api_proto.RateLimitsUpdatedEvent): void {}
}
