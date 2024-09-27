// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Queue } from '@livekit/agents';
import { llm, log } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { ifError } from 'assert';
import { EventEmitter, once } from 'events';
import { WebSocket } from 'ws';
import * as api_proto from './api_proto.js';

export enum EventTypes {
  Error = 'error',
  InputSpeechCommitted = 'input_speech_committed',
  InputSpeechStarted = 'input_speech_started',
  InputSpeechStopped = 'input_speech_stopped',
  InputSpeechTranscriptionCompleted = 'input_speech_transcription_completed',
  InputSpeechTranscriptionFailed = 'input_speech_transcription_failed',
  ResponseContentAdded = 'response_content_added',
  ResponseContentDone = 'response_content_done',
  ResponseCreated = 'response_created',
  ResponseDone = 'response_done',
  ResponseOutputAdded = 'response_output_added',
  ResponseOutputDone = 'response_output_done',
  StartSession = 'start_session',
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
  maxResponseOutputTokens: number;
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
  textStream: Queue<string | null>;
  /** Stream of audio content */
  audioStream: Queue<AudioFrame | null>;
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

export interface InputTranscriptionCompleted {
  itemId: string;
  transcript: string;
}

export interface InputTranscriptionFailed {
  itemId: string;
  message: string;
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
      type: api_proto.ClientEventType.InputAudioBufferAppend,
      audio: Buffer.from(frame.data.buffer).toString('base64'),
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

interface ContentPtr {
  response_id: string;
  output_index: number;
  content_index: number;
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
    maxResponseOutputTokens = 2048,
    apiKey = process.env.OPENAI_API_KEY || '',
    baseURL = api_proto.API_URL,
  }: {
    modalities?: ['text', 'audio'] | ['text'];
    instructions?: string;
    voice?: api_proto.Voice;
    inputAudioFormat?: api_proto.AudioFormat;
    outputAudioFormat?: api_proto.AudioFormat;
    inputAudioTranscription?: { model: 'whisper-1' };
    turnDetection?: api_proto.TurnDetectionType;
    temperature?: number;
    maxResponseOutputTokens?: number;
    apiKey?: string;
    baseURL?: string;
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
      maxResponseOutputTokens,
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
    maxResponseOutputTokens = this.#defaultOpts.maxResponseOutputTokens,
  }: {
    funcCtx?: llm.FunctionContext;
    modalities?: ['text', 'audio'] | ['text'];
    instructions?: string;
    voice?: api_proto.Voice;
    inputAudioFormat?: api_proto.AudioFormat;
    outputAudioFormat?: api_proto.AudioFormat;
    inputAudioTranscription?: { model: 'whisper-1' };
    turnDetection?: api_proto.TurnDetectionType;
    temperature?: number;
    maxResponseOutputTokens?: number;
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
      maxResponseOutputTokens,
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
  #sendQueue = new Queue<api_proto.ClientEvent>();

  constructor(funcCtx: llm.FunctionContext, opts: ModelOptions) {
    super();

    this.#funcCtx = funcCtx;
    this.#opts = opts;

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
      toolChoice: api_proto.ToolChoice.AUTO,
    });
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
    maxResponseOutputTokens: number;
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
      maxResponseOutputTokens,
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
        max_response_output_tokens: this.#opts.maxResponseOutputTokens,
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
        this.#logger.debug(`<- ${JSON.stringify(this.#loggableEvent(event))}`);
        switch (event.type) {
          case api_proto.ServerEventType.Error:
            this.handleError(event);
            break;
          case api_proto.ServerEventType.SessionCreated:
            this.handleSessionCreated(event);
            break;
          case api_proto.ServerEventType.SessionUpdated:
            this.handleSessionUpdated(event);
            break;
          case api_proto.ServerEventType.ConversationCreated:
            this.handleConversationCreated(event);
            break;
          case api_proto.ServerEventType.InputAudioBufferCommitted:
            this.handleInputAudioBufferCommitted(event);
            break;
          case api_proto.ServerEventType.InputAudioBufferCleared:
            this.handleInputAudioBufferCleared(event);
            break;
          case api_proto.ServerEventType.InputAudioBufferSpeechStarted:
            this.handleInputAudioBufferSpeechStarted(event);
            break;
          case api_proto.ServerEventType.InputAudioBufferSpeechStopped:
            this.handleInputAudioBufferSpeechStopped(event);
            break;
          case api_proto.ServerEventType.ConversationItemCreated:
            this.handleConversationItemCreated(event);
            break;
          case api_proto.ServerEventType.ConversationItemInputAudioTranscriptionCompleted:
            this.handleConversationItemInputAudioTranscriptionCompleted(event);
            break;
          case api_proto.ServerEventType.ConversationItemInputAudioTranscriptionFailed:
            this.handleConversationItemInputAudioTranscriptionFailed(event);
            break;
          case api_proto.ServerEventType.ConversationItemTruncated:
            this.handleConversationItemTruncated(event);
            break;
          case api_proto.ServerEventType.ConversationItemDeleted:
            this.handleConversationItemDeleted(event);
            break;
          case api_proto.ServerEventType.ResponseCreated:
            this.handleResponseCreated(event);
            break;
          case api_proto.ServerEventType.ResponseDone:
            this.handleResponseDone(event);
            break;
          case api_proto.ServerEventType.ResponseOutputItemAdded:
            this.handleResponseOutputItemAdded(event);
            break;
          case api_proto.ServerEventType.ResponseOutputItemDone:
            this.handleResponseOutputItemDone(event);
            break;
          case api_proto.ServerEventType.ResponseContentPartAdded:
            this.handleResponseContentPartAdded(event);
            break;
          case api_proto.ServerEventType.ResponseContentPartDone:
            this.handleResponseContentPartDone(event);
            break;
          case api_proto.ServerEventType.ResponseTextDelta:
            this.handleResponseTextDelta(event);
            break;
          case api_proto.ServerEventType.ResponseTextDone:
            this.handleResponseTextDone(event);
            break;
          case api_proto.ServerEventType.ResponseAudioTranscriptDelta:
            this.handleResponseAudioTranscriptDelta(event);
            break;
          case api_proto.ServerEventType.ResponseAudioTranscriptDone:
            this.handleResponseAudioTranscriptDone(event);
            break;
          case api_proto.ServerEventType.ResponseAudioDelta:
            this.handleResponseAudioDelta(event);
            break;
          case api_proto.ServerEventType.ResponseAudioDone:
            this.handleResponseAudioDone(event);
            break;
          case api_proto.ServerEventType.ResponseFunctionCallArgumentsDelta:
            this.handleResponseFunctionCallArgumentsDelta(event);
            break;
          case api_proto.ServerEventType.ResponseFunctionCallArgumentsDone:
            this.handleResponseFunctionCallArgumentsDone(event);
            break;
          case api_proto.ServerEventType.RateLimitsUpdated:
            this.handleRateLimitsUpdated(event);
            break;
        }
      };

      const sendTask = async () => {
        while (this.#ws && !this.#closing && this.#ws.readyState === WebSocket.OPEN) {
          try {
            const event = await this.#sendQueue.get();
            if (event.type !== api_proto.ClientEventType.InputAudioBufferAppend) {
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

  private getContent(ptr: ContentPtr): RealtimeContent {
    const response = this.#pendingResponses[ptr.response_id];
    const output = response.output[ptr.output_index];
    const content = output.content[ptr.content_index];
    return content;
  }

  private handleError(event: api_proto.ErrorEvent): void {
    this.#logger.error('OpenAI S2S error %s', event.error);
  }

  private handleSessionCreated(event: api_proto.SessionCreatedEvent): void {
    this.#sessionId = event.session.id;
  }

  private handleSessionUpdated(event: api_proto.SessionUpdatedEvent): void {}

  private handleConversationCreated(event: api_proto.ConversationCreatedEvent): void {}

  private handleInputAudioBufferCommitted(event: api_proto.InputAudioBufferCommittedEvent): void {
    this.emit(EventTypes.InputSpeechCommitted, {
      itemId: event.item_id,
    });
  }

  private handleInputAudioBufferCleared(event: api_proto.InputAudioBufferClearedEvent): void {}

  private handleInputAudioBufferSpeechStarted(
    event: api_proto.InputAudioBufferSpeechStartedEvent,
  ): void {
    this.emit(EventTypes.InputSpeechStarted);
  }

  private handleInputAudioBufferSpeechStopped(
    event: api_proto.InputAudioBufferSpeechStoppedEvent,
  ): void {
    this.emit(EventTypes.InputSpeechStopped);
  }

  private handleConversationItemCreated(event: api_proto.ConversationItemCreatedEvent): void {}

  private handleConversationItemInputAudioTranscriptionCompleted(
    event: api_proto.ConversationItemInputAudioTranscriptionCompletedEvent,
  ): void {
    const transcript = event.transcript;
    this.emit(EventTypes.InputSpeechTranscriptionCompleted, {
      itemId: event.item_id,
      transcript: transcript,
    });
  }

  private handleConversationItemInputAudioTranscriptionFailed(
    event: api_proto.ConversationItemInputAudioTranscriptionFailedEvent,
  ): void {
    const error = event.error;
    this.#logger.error('OAI S2S failed to transcribe input audio: %s', error.message);
    this.emit(EventTypes.InputSpeechTranscriptionFailed, {
      itemId: event.item_id,
      message: error.message,
    });
  }

  private handleConversationItemTruncated(event: api_proto.ConversationItemTruncatedEvent): void {}

  private handleConversationItemDeleted(event: api_proto.ConversationItemDeletedEvent): void {}

  private handleResponseCreated(responseCreated: api_proto.ResponseCreatedEvent): void {
    const response = responseCreated.response;
    const donePromise = new Promise<void>((resolve) => {
      this.once('response_done', () => resolve());
    });
    const newResponse: RealtimeResponse = {
      id: response.id,
      status: response.status,
      output: [],
      donePromise: () => donePromise,
    };
    this.#pendingResponses[newResponse.id] = newResponse;
    this.emit(EventTypes.ResponseCreated, newResponse);
  }

  private handleResponseDone(event: api_proto.ResponseDoneEvent): void {
    const responseData = event.response;
    const responseId = responseData.id;
    const response = this.#pendingResponses[responseId];
    response.donePromise();
    this.emit(EventTypes.ResponseDone, response);
  }

  private handleResponseOutputItemAdded(event: api_proto.ResponseOutputItemAddedEvent): void {
    const responseId = event.response_id;
    const response = this.#pendingResponses[responseId];
    const itemData = event.item;

    if (itemData.type !== 'message' && itemData.type !== 'function_call') {
      throw new Error(`Unexpected item type: ${itemData.type}`);
    }

    let role: api_proto.Role;
    if (itemData.type === 'function_call') {
      role = api_proto.Role.ASSISTANT; // function_call doesn't have a role field, defaulting it to assistant
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
      donePromise: () =>
        new Promise<void>((resolve) => {
          this.once('response_output_done', (output: RealtimeOutput) => {
            if (output.itemId === itemData.id) {
              resolve();
            }
          });
        }),
    };
    response.output.push(newOutput);
    this.emit(EventTypes.ResponseOutputAdded, newOutput);
  }

  private handleResponseOutputItemDone(event: api_proto.ResponseOutputItemDoneEvent): void {
    const responseId = event.response_id;
    const response = this.#pendingResponses[responseId];
    const outputIndex = event.output_index;
    const output = response.output[outputIndex];

    // TODO: finish implementing
    // if (output.type === "function_call") {
    //   if (!this.#funcCtx) {
    //     this.#logger.error(
    //       "function call received but no funcCtx is available"
    //     );
    //     return;
    //   }

    //   // parse the arguments and call the function inside the fnc_ctx
    //   const item = event.item;
    //   if (item.type !== "function_call") {
    //     throw new Error("Expected function_call item");
    //   }

    //   const funcCallInfo = this.#oai_api.createAiFunctionInfo(
    //     this.#funcCtx,
    //     item.call_id,
    //     item.name,
    //     item.arguments
    //   );

    //   this.#fnc_tasks.createTask(
    //     this.#runFncTask(fnc_call_info, output.item_id)
    //   );
    // }

    output.donePromise();
    this.emit(EventTypes.ResponseOutputDone, output);
  }

  private handleResponseContentPartAdded(event: api_proto.ResponseContentPartAddedEvent): void {
    const responseId = event.response_id;
    const response = this.#pendingResponses[responseId];
    const outputIndex = event.output_index;
    const output = response.output[outputIndex];

    const textStream = new Queue<string>();
    const audioStream = new Queue<AudioFrame>();

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
    };
    output.content.push(newContent);
    this.emit(EventTypes.ResponseContentAdded, newContent);
  }

  private handleResponseContentPartDone(event: api_proto.ResponseContentPartDoneEvent): void {
    const content = this.getContent(event);
    this.emit(EventTypes.ResponseContentDone, content);
  }

  private handleResponseTextDelta(event: api_proto.ResponseTextDeltaEvent): void {}

  private handleResponseTextDone(event: api_proto.ResponseTextDoneEvent): void {}

  private handleResponseAudioTranscriptDelta(
    event: api_proto.ResponseAudioTranscriptDeltaEvent,
  ): void {
    const content = this.getContent(event);
    const transcript = event.delta;
    content.text += transcript;

    content.textStream.put(transcript);
  }

  private handleResponseAudioTranscriptDone(
    event: api_proto.ResponseAudioTranscriptDoneEvent,
  ): void {
    const content = this.getContent(event);
    content.textStream.put(null);
  }

  private handleResponseAudioDelta(event: api_proto.ResponseAudioDeltaEvent): void {
    const content = this.getContent(event);
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

  private handleResponseAudioDone(event: api_proto.ResponseAudioDoneEvent): void {
    const content = this.getContent(event);
    content.audioStream.put(null);
  }

  private handleResponseFunctionCallArgumentsDelta(
    event: api_proto.ResponseFunctionCallArgumentsDeltaEvent,
  ): void {}

  private handleResponseFunctionCallArgumentsDone(
    event: api_proto.ResponseFunctionCallArgumentsDoneEvent,
  ): void {}

  private handleRateLimitsUpdated(event: api_proto.RateLimitsUpdatedEvent): void {}
}

// TODO function init
// if (event.item.type === 'function_call') {
//   const toolCall = event.item;
//   this.options.functions[toolCall.name].execute(toolCall.arguments).then((content) => {
//     this.thinking = false;
//     this.sendClientCommand({
//       type: proto.ClientEventType.ConversationItemCreate,
//       item: {
//         type: 'function_call_output',
//         call_id: toolCall.call_id,
//         output: content,
//       },
//     });
//     this.sendClientCommand({
//       type: proto.ClientEventType.ResponseCreate,
//       response: {},
//     });
//   });
// }
