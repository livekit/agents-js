// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AsyncIterableQueue, Future, Queue } from '@livekit/agents';
import { llm, log, multimodal } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { once } from 'events';
import { WebSocket } from 'ws';
import * as api_proto from './api_proto.js';

interface ModelOptions {
  modalities: ['text', 'audio'] | ['text'];
  instructions: string;
  voice: api_proto.Voice;
  inputAudioFormat: api_proto.AudioFormat;
  outputAudioFormat: api_proto.AudioFormat;
  inputAudioTranscription: api_proto.InputAudioTranscription | null;
  turnDetection: api_proto.TurnDetectionType | null;
  temperature: number;
  maxResponseOutputTokens: number;
  model: api_proto.Model;
  apiKey: string;
  baseURL: string;
}

export interface RealtimeResponse {
  id: string;
  status: api_proto.ResponseStatus;
  statusDetails: api_proto.ResponseStatusDetails | null;
  output: RealtimeOutput[];
  doneFut: Future;
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

  create(item: api_proto.ConversationItemCreateContent, previousItemId?: string): void {
    this.#session.queueMsg({
      type: 'conversation.item.create',
      item,
      previous_item_id: previousItemId,
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

export class RealtimeModel extends multimodal.RealtimeModel {
  sampleRate = api_proto.SAMPLE_RATE;
  numChannels = api_proto.NUM_CHANNELS;
  inFrameSize = api_proto.IN_FRAME_SIZE;
  outFrameSize = api_proto.OUT_FRAME_SIZE;

  #defaultOpts: ModelOptions;
  #sessions: RealtimeSession[] = [];

  constructor({
    modalities = ['text', 'audio'],
    instructions = '',
    voice = 'alloy',
    inputAudioFormat = 'pcm16',
    outputAudioFormat = 'pcm16',
    inputAudioTranscription = { model: 'whisper-1' },
    turnDetection = { type: 'server_vad' },
    temperature = 0.8,
    maxResponseOutputTokens = Infinity,
    model = 'gpt-4o-realtime-preview-2024-10-01',
    apiKey = process.env.OPENAI_API_KEY || '',
    baseURL = api_proto.API_URL,
  }: {
    modalities?: ['text', 'audio'] | ['text'];
    instructions?: string;
    voice?: api_proto.Voice;
    inputAudioFormat?: api_proto.AudioFormat;
    outputAudioFormat?: api_proto.AudioFormat;
    inputAudioTranscription?: api_proto.InputAudioTranscription;
    turnDetection?: api_proto.TurnDetectionType;
    temperature?: number;
    maxResponseOutputTokens?: number;
    model?: api_proto.Model;
    apiKey?: string;
    baseURL?: string;
  }) {
    super();

    if (apiKey === '') {
      throw new Error(
        'OpenAI API key is required, either using the argument or by setting the OPENAI_API_KEY environmental variable',
      );
    }

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
      model,
      apiKey,
      baseURL,
    };
  }

  get sessions(): RealtimeSession[] {
    return this.#sessions;
  }

  session({
    fncCtx,
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
    fncCtx?: llm.FunctionContext;
    modalities?: ['text', 'audio'] | ['text'];
    instructions?: string;
    voice?: api_proto.Voice;
    inputAudioFormat?: api_proto.AudioFormat;
    outputAudioFormat?: api_proto.AudioFormat;
    inputAudioTranscription?: api_proto.InputAudioTranscription | null;
    turnDetection?: api_proto.TurnDetectionType | null;
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
      model: this.#defaultOpts.model,
      apiKey: this.#defaultOpts.apiKey,
      baseURL: this.#defaultOpts.baseURL,
    };

    const newSession = new RealtimeSession(opts, fncCtx);
    this.#sessions.push(newSession);
    return newSession;
  }

  async close() {
    await Promise.allSettled(this.#sessions.map((session) => session.close()));
  }
}

export class RealtimeSession extends multimodal.RealtimeSession {
  #fncCtx: llm.FunctionContext | undefined = undefined;
  #opts: ModelOptions;
  #pendingResponses: { [id: string]: RealtimeResponse } = {};
  #sessionId = 'not-connected';
  #ws: WebSocket | null = null;
  #expiresAt: number | null = null;
  #logger = log();
  #task: Promise<void>;
  #closing = true;
  #sendQueue = new Queue<api_proto.ClientEvent>();

  constructor(opts: ModelOptions, fncCtx?: llm.FunctionContext | undefined) {
    super();

    this.#opts = opts;
    this.#fncCtx = fncCtx;

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

  get fncCtx(): llm.FunctionContext | undefined {
    return this.#fncCtx;
  }

  set fncCtx(ctx: llm.FunctionContext | undefined) {
    this.#fncCtx = ctx;
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
    };

    const tools = this.#fncCtx
      ? Object.entries(this.#fncCtx).map(([name, func]) => ({
          type: 'function' as const,
          name,
          description: func.description,
          parameters: llm.oaiParams(func.parameters),
        }))
      : [];

    this.queueMsg({
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
    });
  }

  #start(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      this.#ws = new WebSocket(
        `${this.#opts.baseURL}?model=${encodeURIComponent(this.#opts.model)}`,
        {
          headers: {
            Authorization: `Bearer ${this.#opts.apiKey}`,
            'OpenAI-Beta': 'realtime=v1',
          },
        },
      );

      this.#ws.onerror = (error) => {
        reject(error);
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
    const output = response.output[ptr.output_index];
    const content = output.content[ptr.content_index];
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
      output: [],
      doneFut: doneFut,
    };
    this.#pendingResponses[newResponse.id] = newResponse;
    this.emit('response_created', newResponse);
  }

  #handleResponseDone(event: api_proto.ResponseDoneEvent): void {
    const responseData = event.response;
    const responseId = responseData.id;
    const response = this.#pendingResponses[responseId];
    response.status = responseData.status;
    response.statusDetails = responseData.status_details;
    this.#pendingResponses[responseId] = response;
    response.doneFut.resolve();
    this.emit('response_done', response);
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
    response.output.push(newOutput);
    this.emit('response_output_added', newOutput);
  }

  #handleResponseOutputItemDone(event: api_proto.ResponseOutputItemDoneEvent): void {
    const responseId = event.response_id;
    const response = this.#pendingResponses[responseId];
    const outputIndex = event.output_index;
    const output = response.output[outputIndex];

    if (output.type === 'function_call') {
      if (!this.#fncCtx) {
        this.#logger.error('function call received but no fncCtx is available');
        return;
      }

      // parse the arguments and call the function inside the fnc_ctx
      const item = event.item;
      if (item.type !== 'function_call') {
        throw new Error('Expected function_call item');
      }

      this.emit('function_call_started', {
        callId: item.call_id,
      });

      const parsedArgs = JSON.parse(item.arguments);

      this.#logger.debug(
        `[Function Call ${item.call_id}] Executing ${item.name} with arguments ${parsedArgs}`,
      );

      this.#fncCtx[item.name].execute(parsedArgs).then(
        (content) => {
          this.#logger.debug(`[Function Call ${item.call_id}] ${item.name} returned ${content}`);
          this.emit('function_call_completed', {
            callId: item.call_id,
          });
          this.conversation.item.create(
            {
              type: 'function_call_output',
              call_id: item.call_id,
              output: content,
            },
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

    output.doneFut.resolve();
    this.emit('response_output_done', output);
  }

  #handleResponseContentPartAdded(event: api_proto.ResponseContentPartAddedEvent): void {
    const responseId = event.response_id;
    const response = this.#pendingResponses[responseId];
    const outputIndex = event.output_index;
    const output = response.output[outputIndex];

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
    };
    output.content.push(newContent);
    this.emit('response_content_added', newContent);
  }

  #handleResponseContentPartDone(event: api_proto.ResponseContentPartDoneEvent): void {
    const content = this.#getContent(event);
    this.emit('response_content_done', content);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #handleResponseTextDelta(event: api_proto.ResponseTextDeltaEvent): void {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #handleResponseTextDone(event: api_proto.ResponseTextDoneEvent): void {}

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
