// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Queue } from '@livekit/agents';
import { llm, log } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter, once } from 'events';
import { WebSocket } from 'ws';
import * as api_proto from './api_proto.js';

export enum OmniAssistantEvents {
  Error,
  InputSpeechCommitted,
  InputSpeechStarted,
  InputSpeechStopped,
  InputSpeechTranscriptionCompleted,
  InputSpeechTranscriptionFailed,
  ResponseContentAdded,
  ResponseContentDone,
  ResponseCreated,
  ResponseDone,
  ResponseOutputAdded,
  ResponseOutputDone,
  StartSession,
}

interface ModelOptions {
  modalities: ['text', 'audio'] | ['text'];
  instructions?: string;
  voice: api_proto.Voice;
  inputAudioFormat: api_proto.AudioFormat;
  outputAudioFormat: api_proto.AudioFormat;
  inputAudioTranscription?: {
    model: 'whisper-1';
  };
  turnDetection:
    | {
        type: 'server_vad';
        threshold?: number;
        prefix_padding_ms?: number;
        silence_duration_ms?: number;
      }
    | 'none';
  temperature: number;
  maxOutputTokens: number;
  apiKey: string;
  baseURL: string;
}

export interface RealtimeResponse {
  /** ID of the message */
  id: string;
  /** Status of the response */
  status: api_proto.ResponseStatus;
  /** List of outputs */
  output: RealtimeOutput[];
  /** Promise that will be executed when the response is completed */
  donePromise: () => Promise<void>;
}

export interface RealtimeOutput {
  /** ID of the response */
  responseId: string;
  /** ID of the item */
  itemId: string;
  /** Index of the output */
  outputIndex: number;
  /** Role of the message */
  role: api_proto.Role;
  /** Type of the output */
  type: 'message' | 'function_call';
  /** List of content */
  content: RealtimeContent[];
  /** Promise that will be executed when the response is completed */
  donePromise: () => Promise<void>;
}

export interface RealtimeContent {
  /** ID of the response */
  responseId: string;
  /** ID of the item */
  itemId: string;
  /** Index of the output */
  outputIndex: number;
  /** Index of the content */
  contentIndex: number;
  /** Accumulated text content */
  text: string;
  /** Accumulated audio content */
  audio: AudioFrame[];
  /** Stream of text content */
  textStream: Queue<string>;
  /** Stream of audio content */
  AudioStream: Queue<AudioFrame>;
  /** Pending tool calls */
  toolCalls: RealtimeToolCall[];
}

export interface RealtimeToolCall {
  /** Name of the function */
  name: string;
  /** Accumulated arguments */
  arguments: string;
  /** ID of the tool call */
  toolCallID: string;
}

class InputAudioBuffer {
  #session: RealtimeSession;

  constructor(session: RealtimeSession) {
    this.#session = session;
  }

  append(frame: AudioFrame) {
    this.#session.queueMsg({
      type: api_proto.ClientEventType.InputAudioBufferAppend,
      audio: Buffer.from(frame.data).toString('base64'),
    });
  }

  clear() {
    this.#session.queueMsg({
      type: api_proto.ClientEventType.InputAudioBufferClear,
    });
  }

  commit() {
    this.#session.queueMsg({
      type: api_proto.ClientEventType.InputAudioBufferCommit,
    });
  }
}

class ConversationItem {
  #session: RealtimeSession;

  constructor(session: RealtimeSession) {
    this.#session = session;
  }

  // create(message: llm.ChatMessage, previousItemId?: string) {
  //   // TODO: Implement create method
  //   throw new Error('Not implemented');
  // }

  truncate(itemId: string, contentIndex: number, audioEnd: number) {
    this.#session.queueMsg({
      type: api_proto.ClientEventType.ConversationItemTruncate,
      item_id: itemId,
      content_index: contentIndex,
      audio_end_ms: audioEnd,
    });
  }

  delete(itemId: string) {
    this.#session.queueMsg({
      type: api_proto.ClientEventType.ConversationItemDelete,
      item_id: itemId,
    });
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
      type: api_proto.ClientEventType.ResponseCreate,
    });
  }

  cancel() {
    this.#session.queueMsg({
      type: api_proto.ClientEventType.ResponseCancel,
    });
  }
}

export class RealtimeModel {
  #baseURL: string;
  #apiKey: string;
  #defaultOpts: ModelOptions;
  #sessions: RealtimeSession[] = [];

  constructor({
    modalities = ['text', 'audio'],
    instructions = undefined,
    voice = api_proto.Voice.ALLOY,
    inputAudioFormat = api_proto.AudioFormat.PCM16,
    outputAudioFormat = api_proto.AudioFormat.PCM16,
    inputAudioTranscription = { model: 'whisper-1' },
    turnDetection = { type: 'server_vad' },
    temperature = 0.8,
    maxOutputTokens = 2048,
    apiKey = process.env.OPENAI_API_KEY || '',
    baseURL = api_proto.API_URL,
  }: {
    modalities: ['text', 'audio'] | ['text'];
    instructions?: string;
    voice: api_proto.Voice;
    inputAudioFormat: api_proto.AudioFormat;
    outputAudioFormat: api_proto.AudioFormat;
    inputAudioTranscription: { model: 'whisper-1' };
    turnDetection: api_proto.TurnDetectionType;
    temperature: number;
    maxOutputTokens: number;
    apiKey: string;
    baseURL: string;
  }) {
    if (apiKey === '') {
      throw new Error(
        'OpenAI API key is required, either using the argument or by setting the OPENAI_API_KEY environmental variable',
      );
    }

    this.#apiKey = apiKey;
    this.#baseURL = baseURL;
    this.#defaultOpts = {
      modalities,
      instructions,
      voice,
      inputAudioFormat,
      outputAudioFormat,
      inputAudioTranscription,
      turnDetection,
      temperature,
      maxOutputTokens,
      apiKey,
      baseURL,
    };
  }

  get sessions(): RealtimeSession[] {
    return this.#sessions;
  }

  session({
    funcCtx = {},
    modalities = this.#defaultOpts.modalities,
    instructions = this.#defaultOpts.instructions,
    voice = this.#defaultOpts.voice,
    inputAudioFormat = this.#defaultOpts.inputAudioFormat,
    outputAudioFormat = this.#defaultOpts.outputAudioFormat,
    inputAudioTranscription = this.#defaultOpts.inputAudioTranscription,
    turnDetection = this.#defaultOpts.turnDetection,
    temperature = this.#defaultOpts.temperature,
    maxOutputTokens = this.#defaultOpts.maxOutputTokens,
  }: {
    funcCtx: llm.FunctionContext;
    modalities: ['text', 'audio'] | ['text'];
    instructions?: string;
    voice: api_proto.Voice;
    inputAudioFormat: api_proto.AudioFormat;
    outputAudioFormat: api_proto.AudioFormat;
    inputAudioTranscription?: { model: 'whisper-1' };
    turnDetection: api_proto.TurnDetectionType;
    temperature: number;
    maxOutputTokens: number;
  }): RealtimeSession {
    const opts: ModelOptions = {
      modalities,
      instructions,
      voice,
      inputAudioFormat,
      outputAudioFormat,
      inputAudioTranscription,
      turnDetection,
      temperature,
      maxOutputTokens,
      apiKey: this.#defaultOpts.apiKey,
      baseURL: this.#defaultOpts.baseURL,
    };

    const newSession = new RealtimeSession(funcCtx, opts);
    this.#sessions.push(newSession);
    return newSession;
  }

  async close(): Promise<void> {
    // TODO: Implement close method
    throw new Error('Not implemented');
  }
}

export class RealtimeSession extends EventEmitter {
  #funcCtx: llm.FunctionContext;
  #opts: ModelOptions;
  #pendingResponses: { [id: string]: RealtimeResponse } = {};
  #sessionId = 'not-connected';
  #ws: WebSocket | null = null;
  #logger = log();
  #task: Promise<void>;
  #closing = true;

  constructor(funcCtx: llm.FunctionContext, opts: ModelOptions) {
    super();

    this.#funcCtx = funcCtx;
    this.#opts = opts;

    this.#task = this.#start();
  }

  get funcCtx(): llm.FunctionContext {
    return this.#funcCtx;
  }

  set funcCtx(ctx: llm.FunctionContext) {
    this.#funcCtx = ctx;
  }

  get defaultConversation(): Conversation {
    return new Conversation(this);
  }

  get inputAudioBuffer(): InputAudioBuffer {
    return new InputAudioBuffer(this);
  }

  get response(): Response {
    return new Response(this);
  }

  queueMsg(command: api_proto.ClientEvent): void {
    const isAudio = command.type === 'input_audio_buffer.append';

    if (!this.#ws) {
      if (!isAudio) this.#logger.error('WebSocket is not connected');
      return;
    }

    if (!isAudio) {
      this.#logger.debug(`-> ${JSON.stringify(this.#loggableEvent(command))}`);
    }
    this.#ws.send(JSON.stringify(command));
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
    maxOutputTokens = this.#opts.maxOutputTokens,
    toolChoice = api_proto.ToolChoice.AUTO,
  }: {
    modalities: ['text', 'audio'] | ['text'];
    instructions?: string;
    voice: api_proto.Voice;
    inputAudioFormat: api_proto.AudioFormat;
    outputAudioFormat: api_proto.AudioFormat;
    inputAudioTranscription?: { model: 'whisper-1' };
    turnDetection: api_proto.TurnDetectionType;
    temperature: number;
    maxOutputTokens: number;
    toolChoice: api_proto.ToolChoice;
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
      maxOutputTokens,
      apiKey: this.#opts.apiKey,
      baseURL: this.#opts.baseURL,
    };

    const tools = Object.entries(this.#funcCtx).map(([name, func]) => ({
      type: 'function' as const,
      name,
      description: func.description,
      parameters: llm.oaiParams(func.parameters),
    }));
    this.queueMsg({
      type: api_proto.ClientEventType.SessionUpdate,
      session: {
        modalities: this.#opts.modalities,
        instructions: this.#opts.instructions,
        voice: this.#opts.voice,
        input_audio_format: this.#opts.inputAudioFormat,
        output_audio_format: this.#opts.outputAudioFormat,
        input_audio_transcription: this.#opts.inputAudioTranscription,
        turn_detection: this.#opts.turnDetection,
        temperature: this.#opts.temperature,
        max_output_tokens: this.#opts.maxOutputTokens,
        tools,
        tool_choice: toolChoice,
      },
    });
  }

  #start(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      this.#ws = new WebSocket(api_proto.API_URL, {
        headers: {
          Authorization: `Bearer ${this.#opts.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      this.#ws.onerror = (error) => {
        reject(error.message);
      };

      await once(this.#ws, 'open');
      this.#closing = false;

      this.#ws.onmessage = (message) => {
        const event: api_proto.ServerEvent = JSON.parse(message.data as string);
        switch (event.type) {
          case api_proto.ServerEventType.Error:
            // TODO: Emit error event
            break;
          case api_proto.ServerEventType.SessionCreated:
          case api_proto.ServerEventType.SessionUpdated:
          case api_proto.ServerEventType.ConversationCreated:
          case api_proto.ServerEventType.InputAudioBufferCommitted:
            // TODO: Emit input_speech_committed event
            break;
          case api_proto.ServerEventType.InputAudioBufferCleared:
            break;
          case api_proto.ServerEventType.InputAudioBufferSpeechStarted:
            // TODO: Emit input_speech_started event
            break;
          case api_proto.ServerEventType.InputAudioBufferSpeechStopped:
            // TODO: Emit input_speech_stopped event
            break;
          case api_proto.ServerEventType.ConversationItemCreated:
            break;
          case api_proto.ServerEventType.ConversationItemInputAudioTranscriptionCompleted:
            // TODO: Emit input_speech_transcription_completed event
            break;
          case api_proto.ServerEventType.ConversationItemInputAudioTranscriptionFailed:
            // TODO: Emit input_speech_transcription_failed event
            break;
          case api_proto.ServerEventType.ConversationItemTruncated:
          case api_proto.ServerEventType.ConversationItemDeleted:
            break;
          case api_proto.ServerEventType.ResponseCreated:
            // TODO: Emit response_created event
            break;
          case api_proto.ServerEventType.ResponseDone:
            // TODO: Emit response_done event
            break;
          case api_proto.ServerEventType.ResponseOutputAdded:
            // TODO: Emit response_output_added event
            break;
          case api_proto.ServerEventType.ResponseOutputDone:
            // TODO: Emit response_output_done event
            break;
          case api_proto.ServerEventType.ResponseContentAdded:
            // TODO: Emit response_content_added event
            break;
          case api_proto.ServerEventType.ResponseContentDone:
            // TODO: Emit response_content_done event
            break;
          case api_proto.ServerEventType.ResponseTextDelta:
          case api_proto.ServerEventType.ResponseTextDone:
          case api_proto.ServerEventType.ResponseAudioTranscriptDelta:
          case api_proto.ServerEventType.ResponseAudioTranscriptDone:
          case api_proto.ServerEventType.ResponseAudioDelta:
          case api_proto.ServerEventType.ResponseAudioDone:
          case api_proto.ServerEventType.ResponseFunctionCallArgumentsDelta:
          case api_proto.ServerEventType.ResponseFunctionCallArgumentsDone:
          case api_proto.ServerEventType.RateLimitsUpdated:
            break;
        }
      };

      this.#ws.onclose = () => {
        if (!this.#closing) {
          reject('OpenAI S2S connection closed unexpectedly');
        }
        this.#ws = null;
        resolve();
      };
    });
  }

  async close(): Promise<void> {
    // TODO: Implement close method
    throw new Error('Not implemented');
  }
}

// TODO: implement for event emitting
// interface InputTranscriptionCompleted {
//   itemId: string;
//   transcript: string;
// }

// interface InputTranscriptionFailed {
//   itemId: string;
//   message: string;
// }
