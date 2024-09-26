// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Queue } from '@livekit/agents';
import { llm, log } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter, once } from 'events';
import { WebSocket } from 'ws';
import * as proto from './api_proto.js';

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
  voice: proto.Voice;
  inputAudioFormat: proto.AudioFormat;
  outputAudioFormat: proto.AudioFormat;
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
  status: proto.ResponseStatus;
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
  role: 'user' | 'assistant' | 'system';
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
      type: proto.ClientEventType.InputAudioBufferAppend,
      audio: Buffer.from(frame.data).toString('base64'),
    });
  }

  clear() {
    this.#session.queueMsg({
      type: proto.ClientEventType.InputAudioBufferClear,
    });
  }

  commit() {
    this.#session.queueMsg({
      type: proto.ClientEventType.InputAudioBufferCommit,
    });
  }
}

class ConversationItem {
  #session: RealtimeSession;

  constructor(session: RealtimeSession) {
    this.#session = session;
  }

  // TODO(nbsp): add ChatMessage to llm
  // create()

  truncate(itemId: string, contentIndex: number, audioEnd: number) {
    this.#session.queueMsg({
      type: proto.ClientEventType.ConversationItemTruncate,
      item_id: itemId,
      content_index: contentIndex,
      audio_end_ms: audioEnd,
    });
  }

  delete(itemId: string) {
    this.#session.queueMsg({
      type: proto.ClientEventType.ConversationItemDelete,
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
      type: proto.ClientEventType.ResponseCreate,
    });
  }

  cancel() {
    this.#session.queueMsg({
      type: proto.ClientEventType.ResponseCancel,
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
    voice = proto.Voice.ALLOY,
    inputAudioFormat = proto.AudioFormat.PCM16,
    outputAudioFormat = proto.AudioFormat.PCM16,
    inputAudioTranscription = { model: 'whisper-1' },
    turnDetection = { type: 'server_vad' },
    temperature = 0.8,
    maxOutputTokens = 2048,
    apiKey = process.env.OPENAI_API_KEY || '',
    baseURL = proto.API_URL,
  }: {
    modalities: ['text', 'audio'] | ['text'];
    instructions?: string;
    voice: proto.Voice;
    inputAudioFormat: proto.AudioFormat;
    outputAudioFormat: proto.AudioFormat;
    inputAudioTranscription: { model: 'whisper-1' };
    turnDetection: proto.TurnDetectionType;
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
    voice: proto.Voice;
    inputAudioFormat: proto.AudioFormat;
    outputAudioFormat: proto.AudioFormat;
    inputAudioTranscription?: { model: 'whisper-1' };
    turnDetection: proto.TurnDetectionType;
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

  queueMsg(command: proto.ClientEvent): void {
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
    event: proto.ClientEvent | proto.ServerEvent,
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
    toolChoice = proto.ToolChoice.AUTO,
  }: {
    modalities: ['text', 'audio'] | ['text'];
    instructions?: string;
    voice: proto.Voice;
    inputAudioFormat: proto.AudioFormat;
    outputAudioFormat: proto.AudioFormat;
    inputAudioTranscription?: { model: 'whisper-1' };
    turnDetection: proto.TurnDetectionType;
    temperature: number;
    maxOutputTokens: number;
    toolChoice: proto.ToolChoice;
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
      type: proto.ClientEventType.SessionUpdate,
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
      this.#ws = new WebSocket(proto.API_URL, {
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
        const event: proto.ServerEvent = JSON.parse(message.data as string);
        switch (event.type) {
          case proto.ServerEventType.Error:
          case proto.ServerEventType.SessionCreated:
          case proto.ServerEventType.SessionUpdated:
          case proto.ServerEventType.ConversationCreated:
          case proto.ServerEventType.InputAudioBufferCommitted:
          case proto.ServerEventType.InputAudioBufferCleared:
          case proto.ServerEventType.InputAudioBufferSpeechStarted:
          case proto.ServerEventType.InputAudioBufferSpeechStopped:
          case proto.ServerEventType.ConversationItemCreated:
          case proto.ServerEventType.ConversationItemInputAudioTranscriptionCompleted:
          case proto.ServerEventType.ConversationItemInputAudioTranscriptionFailed:
          case proto.ServerEventType.ConversationItemTruncated:
          case proto.ServerEventType.ConversationItemDeleted:
          case proto.ServerEventType.ResponseCreated:
          case proto.ServerEventType.ResponseDone:
          case proto.ServerEventType.ResponseOutputAdded:
          case proto.ServerEventType.ResponseOutputDone:
          case proto.ServerEventType.ResponseContentAdded:
          case proto.ServerEventType.ResponseContentDone:
          case proto.ServerEventType.ResponseTextDelta:
          case proto.ServerEventType.ResponseTextDone:
          case proto.ServerEventType.ResponseAudioTranscriptDelta:
          case proto.ServerEventType.ResponseAudioTranscriptDone:
          case proto.ServerEventType.ResponseAudioDelta:
          case proto.ServerEventType.ResponseAudioDone:
          case proto.ServerEventType.ResponseFunctionCallArgumentsDelta:
          case proto.ServerEventType.ResponseFunctionCallArgumentsDone:
          case proto.ServerEventType.RateLimitsUpdated:
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
}
