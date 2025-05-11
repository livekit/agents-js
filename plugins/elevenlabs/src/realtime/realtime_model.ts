// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AsyncIterableQueue, Queue, log, multimodal } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import * as api_proto from './api_proto.js';

interface ModelAudioOptions {
  sampleRate: number;
  inFrameSize: number;
  outFrameSize: number;
}

interface ModelOptions {
  agentId: string;
  configOverride?: Omit<api_proto.ConversationInitiationClientDataEvent, 'type'>;
  apiKey?: string;
  audioOptions?: ModelAudioOptions;
}

class InputAudioBuffer {
  #session: RealtimeSession;

  constructor(session: RealtimeSession) {
    this.#session = session;
  }

  append(frame: AudioFrame) {
    this.#session.queueMsg({
      type: 'user_audio_chunk',
      audio: Buffer.from(frame.data.buffer).toString('base64'),
    });
  }
}

export interface RealtimeContent {
  itemId: string;
  contentIndex: number;
  audio: AudioFrame[];
  text: string;
  textStream: AsyncIterableQueue<string>;
  audioStream: AsyncIterableQueue<AudioFrame>;
  contentType: api_proto.ContentType;
  locked: boolean;
}

export class RealtimeModel extends multimodal.RealtimeModel {
  numChannels = api_proto.NUM_CHANNELS;
  sampleRate: number;
  inFrameSize: number;
  outFrameSize: number;

  #defaultOpts: ModelOptions;
  #sessions: RealtimeSession[] = [];

  constructor({
    agentId,
    configOverride = {},
    audioOptions = {
      sampleRate: api_proto.DEFAULT_SAMPLE_RATE,
      inFrameSize: api_proto.DEFAULT_IN_FRAME_SIZE,
      outFrameSize: api_proto.DEFAULT_OUT_FRAME_SIZE,
    },
    apiKey = process.env.ELEVEN_API_KEY || '',
  }: ModelOptions) {
    super();

    // ElevenLabs' agents might have different sample rates,
    // most commonly 16000 and 22050.
    this.sampleRate = audioOptions.sampleRate;
    this.inFrameSize = audioOptions.inFrameSize;
    this.outFrameSize = audioOptions.outFrameSize;

    if (!apiKey) {
      throw new Error(
        'ElevenLabs API key is required, either using the argument or by setting the ELEVEN_API_KEY environment variable',
      );
    }

    this.#defaultOpts = {
      agentId,
      configOverride,
      audioOptions,
      apiKey,
    };
  }

  get sessions(): RealtimeSession[] {
    return this.#sessions;
  }

  session(): multimodal.RealtimeSession {
    const newSession = new RealtimeSession(this.#defaultOpts);
    this.#sessions.push(newSession);
    return newSession;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.#sessions.map((session) => session.close()));
  }
}

export class RealtimeSession extends multimodal.RealtimeSession {
  // This is undefined until we add support for local tool calls
  fncCtx = undefined;

  #pendingContent: { [id: number]: RealtimeContent } = {};
  #opts: ModelOptions;
  #ws: WebSocket | null = null;
  #task: Promise<void>;
  #logger = log();
  #sendQueue = new Queue<api_proto.ClientEvent>();

  constructor(opts: ModelOptions) {
    super();
    this.#opts = opts;

    this.#task = this.#start();
  }

  get conversation() {
    return {
      item: {
        truncate: () => {},
      },
    };
  }

  get inputAudioBuffer(): InputAudioBuffer {
    return new InputAudioBuffer(this);
  }

  queueMsg(command: api_proto.ClientEvent): void {
    this.#sendQueue.put(command);
  }

  #getContent(id?: number): RealtimeContent | undefined {
    if (id) return this.#pendingContent[id];
    //if no id is provided, return the free content with the lowest index
    const freeContents = Object.values(this.#pendingContent).filter((a) => !a.locked);
    if (freeContents.length === 0) return undefined;
    return freeContents.reduce((a, b) => (a.contentIndex < b.contentIndex ? a : b));
  }

  /// Truncates the data field of the event to the specified maxLength to avoid overwhelming logs
  /// with large amounts of base64 audio data.
  #loggableEvent(
    event: api_proto.ClientEvent | api_proto.ServerEvent,
    maxLength: number = 30,
  ): Record<string, unknown> {
    const truncateString = (str: string, maxLength: number) =>
      str.slice(0, maxLength) + (str.length > maxLength ? '…' : '');

    if (event.type === 'user_audio_chunk') {
      return { ...event, audio: truncateString(event.audio as string, maxLength) };
    }

    if (event.type === 'audio') {
      return {
        ...event,
        audio_event: {
          ...event.audio_event,
          audio_base_64: truncateString(event.audio_event.audio_base_64 as string, maxLength),
        },
      };
    }

    return { ...event };
  }

  /**
   * Required method in the LiveKit API.
   *
   * @remarks
   * This method is part of the LiveKit API contract but has no equivalent functionality
   * in the ElevenLabs implementation. It is not supported and will throw an error if called.
   */
  recoverFromTextResponse() {
    throw new Error('Recovery from text is not supported on this model');
  }

  #start(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const headers: Record<string, string> = {
        'User-Agent': 'LiveKit-Agents-JS',
      };

      const url = new URL(api_proto.BASE_URL);
      url.searchParams.set('agent_id', this.#opts.agentId);

      console.debug('Connecting to ElevenLabs Conversational AI API at', url.toString());
      this.#ws = new WebSocket(url.toString(), {
        headers,
      });

      this.#ws.onerror = (error) => {
        reject(new Error('ElevenLabs Conversational AI WebSocket error: ' + error.message));
      };

      await once(this.#ws, 'open');

      // First, we send the conversation initiation event to the server.
      this.#ws.send(
        JSON.stringify({
          type: 'conversation_initiation_client_data',
          ...this.#opts.configOverride,
        } satisfies api_proto.ConversationInitiationClientDataEvent),
      );

      this.#ws.onmessage = (message) => {
        const event: api_proto.ServerEvent = JSON.parse(message.data.toString());
        if (event.type !== 'ping') {
          this.#logger.debug(`<- ${JSON.stringify(this.#loggableEvent(event))}`);
        }
        switch (event.type) {
          case 'conversation_initiation_metadata':
            this.#handleConversationInitialization(event);
            break;
          case 'user_transcript':
            this.#handleUserTranscript(event);
            break;
          case 'agent_response':
            this.#handleAgentTextResponse(event);
            break;
          case 'audio':
            this.#handleIncomingAudio(event);
            break;
          case 'interruption':
            this.#handleInterruption(event);
            break;
          case 'ping':
            this.#handlePing(event);
            break;
          //NOTE: Not supported yet
          case 'client_tool_call':
          case 'contextual_update':
          case 'vad_score':
          //NOTE: defug events
          case 'agent_response_correction':
          case 'internal_tentative_agent_response':
            break;
        }
      };

      const sendTask = async () => {
        while (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
          try {
            const event = await this.#sendQueue.get();
            this.#logger.debug(`-> ${JSON.stringify(this.#loggableEvent(event))}`);

            // The ElevenLabs API defines all events in a consistent manner, except for `user_audio_chunk`.
            // To address this inconsistency, we standardize the event to match the common structure.
            // However, when sending the event, it must be transformed back to align with the ElevenLabs specification.
            // see: https://elevenlabs.io/docs/conversational-ai/api-reference/conversational-ai/websocket#send.User-Audio-Chunk
            const dataToSend =
              event.type === 'user_audio_chunk' ? { user_audio_chunk: event.audio } : event;

            this.#ws.send(JSON.stringify(dataToSend));
          } catch (error) {
            this.#logger.error('Error sending event:', error);
          }
        }
      };

      sendTask();

      this.#ws.onclose = () => {
        this.#ws = null;
        this.#logger.debug('WebSocket connection closed by ElevenLabs');
        resolve();
      };
    });
  }

  async close() {
    if (!this.#ws) return;
    this.#ws.close();
    await this.#task;
  }

  #handlePing(event: api_proto.PingEvent): void {
    this.queueMsg({
      type: 'pong',
      event_id: event.ping_event.event_id,
    });
  }

  #handleIncomingAudio(event: api_proto.AudioResponseEvent): void {
    const data = Buffer.from(event.audio_event.audio_base_64, 'base64');
    const audio = new AudioFrame(
      new Int16Array(data.buffer),
      this.#opts.audioOptions?.sampleRate || api_proto.DEFAULT_SAMPLE_RATE,
      api_proto.NUM_CHANNELS,
      data.length / 2,
    );
    const content = this.#getContent(event.audio_event.event_id);
    if (content) {
      // If we already received an event with the same id, we can just append the audio to the existing content
      content.audio.push(audio);
      content.audioStream.put(audio);
      this.emit('response_content_updated', content);
    } else {
      // If we haven't received an event with the same id, we need to create a new content object
      const textStream = new AsyncIterableQueue<string>();
      const audioStream = new AsyncIterableQueue<AudioFrame>();
      audioStream.put(audio);

      const newContent: RealtimeContent = {
        itemId: randomUUID(),
        contentIndex: event.audio_event.event_id,
        text: '',
        audio: [audio],
        textStream,
        audioStream,
        contentType: 'audio',
        locked: false,
      };
      this.#pendingContent[event.audio_event.event_id] = newContent;
      this.emit('response_content_added', newContent);
    }
  }

  #handleAgentTextResponse(event: api_proto.AgentResponseEvent): void {
    const content = this.#getContent(); // get the first remaining content
    //Ignore, is a silence that doesn't have an audio content,
    //but ElevenLabs sends '...'
    if (!content) return;

    //lock the content so it can't be modified anymore
    content.locked = true;

    const transcript = event.agent_response_event.agent_response;
    content.text = transcript;
    content.textStream.put(transcript);

    //close the streams because the AgentReponseEvent is the last event for this content
    content.textStream.close();
    content.audioStream.close();

    //TODO: figure out how to clean the content from the pendingContent map

    this.emit('response_content_done', content);
  }

  #handleUserTranscript(event: api_proto.UserTranscriptEvent): void {
    const transcript = event.user_transcription_event.user_transcript || '';
    this.emit('input_speech_transcription_completed', {
      itemId: randomUUID(),
      transcript,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #handleConversationInitialization(event: api_proto.ConversationInitiationMetadataEvent): void {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  #handleInterruption(event: api_proto.InterruptionEvent) {
    //NOTE: we don't need to close the content here, because the "agent_response_event" will do that
    this.emit('input_speech_started', {
      itemId: randomUUID(),
    });
  }
}
