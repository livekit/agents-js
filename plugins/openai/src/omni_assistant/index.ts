// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioByteStream } from '@livekit/agents';
import { findMicroTrackId } from '@livekit/agents';
import { llm, log } from '@livekit/agents';
import type {
  AudioFrameEvent,
  LocalTrackPublication,
  RemoteAudioTrack,
  RemoteParticipant,
  Room,
} from '@livekit/rtc-node';
import {
  AudioSource,
  AudioStream,
  AudioStreamEvent,
  LocalAudioTrack,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { AgentPlayout, type PlayoutHandle } from './agent_playout.js';
import * as proto from './proto.js';
import { BasicTranscriptionForwarder } from './transcription_forwarder.js';

/** @hidden */
export const defaultSessionConfig: Partial<proto.SessionResource> = {
  turn_detection: {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 200,
  },
  input_audio_format: 'pcm16',
  input_audio_transcription: {
    model: 'whisper-1',
  },
};

/** @hidden */
export const defaultConversationConfig: proto.ResponseCreateEvent['response'] = {
  modalities: ['text', 'audio'],
  instructions: 'You are a helpful assistant.',
  voice: 'alloy',
  output_audio_format: 'pcm16',
  tools: [],
  tool_choice: 'auto',
  temperature: 0.8,
  max_output_tokens: 2048,
};

type ImplOptions = {
  apiKey: string;
  sessionConfig: Partial<proto.SessionResource>;
  conversationConfig: proto.ResponseCreateEvent['response'];
  functions: llm.FunctionContext;
};

/** @alpha */
export class OmniAssistant {
  options: ImplOptions;
  room: Room | null = null;
  linkedParticipant: RemoteParticipant | null = null;
  subscribedTrack: RemoteAudioTrack | null = null;
  readMicroTask: { promise: Promise<void>; cancel: () => void } | null = null;

  constructor({
    sessionConfig = defaultSessionConfig,
    conversationConfig = defaultConversationConfig,
    functions = {},
    apiKey = process.env.OPENAI_API_KEY || '',
  }: {
    sessionConfig?: Partial<proto.SessionResource>;
    conversationConfig?: proto.ResponseCreateEvent['response'];
    functions?: llm.FunctionContext;
    apiKey?: string;
  }) {
    if (!apiKey) {
      throw new Error('OpenAI API key is required, whether as an argument or as $OPENAI_API_KEY');
    }

    conversationConfig.tools = tools(functions);
    this.options = {
      apiKey,
      sessionConfig,
      conversationConfig,
      functions,
    };
  }

  private ws: WebSocket | null = null;
  private connected: boolean = false;
  private thinking: boolean = false;
  private participant: RemoteParticipant | string | null = null;
  private agentPublication: LocalTrackPublication | null = null;
  private localTrackSid: string | null = null;
  private localSource: AudioSource | null = null;
  private agentPlayout: AgentPlayout | null = null;
  private playingHandle: PlayoutHandle | null = null;
  private logger = log();

  get funcCtx(): llm.FunctionContext {
    return this.options.functions;
  }
  set funcCtx(ctx: llm.FunctionContext) {
    this.options.functions = ctx;
    this.options.conversationConfig.tools = tools(ctx);
    this.sendClientCommand({
      type: 'response.create',
      response: this.options.conversationConfig,
    });
  }

  start(room: Room, participant: RemoteParticipant | string | null = null): Promise<void> {
    return new Promise(async (resolve, reject) => {
      if (this.ws !== null) {
        this.logger.warn('VoiceAssistant already started');
        resolve();
        return;
      }

      room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        if (!this.linkedParticipant) {
          return;
        }

        this.linkParticipant(participant.identity);
      });
      this.room = room;
      this.participant = participant;
      this.setState(proto.State.INITIALIZING);

      this.localSource = new AudioSource(proto.SAMPLE_RATE, proto.NUM_CHANNELS);
      this.agentPlayout = new AgentPlayout(this.localSource);
      const track = LocalAudioTrack.createAudioTrack('assistant_voice', this.localSource);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      this.agentPublication = (await room.localParticipant?.publishTrack(track, options)) || null;
      if (!this.agentPublication) {
        this.logger.error('Failed to publish track');
        reject(new Error('Failed to publish track'));
        return;
      }

      await this.agentPublication.waitForSubscription();

      if (participant) {
        if (typeof participant === 'string') {
          this.linkParticipant(participant);
        } else {
          this.linkParticipant(participant.identity);
        }
      } else {
        // No participant specified, try to find the first participant in the room
        for (const participant of room.remoteParticipants.values()) {
          this.linkParticipant(participant.identity);
          break;
        }
      }

      this.ws = new WebSocket(proto.API_URL, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      this.ws.onopen = () => {
        this.connected = true;
        this.sendClientCommand({
          type: 'session.update',
          session: this.options.sessionConfig,
        });
        this.sendClientCommand({
          type: 'response.create',
          response: this.options.conversationConfig,
        });
        resolve();
      };

      this.ws.onerror = (error) => {
        reject(error);
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.ws = null;
      };

      this.ws.onmessage = (message) => {
        this.handleServerEvent(JSON.parse(message.data as string));
      };
    });
  }

  // user-initiated close
  close() {
    if (!this.connected || !this.ws) return;
    this.logger.debug('stopping assistant');
    this.ws.close();
  }

  addUserMessage(text: string, generate: boolean = true): void {
    this.sendClientCommand({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: text,
          },
        ],
      },
    });
    if (generate) {
      this.sendClientCommand({
        type: 'response.create',
        response: {},
      });
    }
  }

  private setState(state: proto.State) {
    // don't override thinking until done
    if (this.thinking) return;
    if (this.room?.isConnected && this.room.localParticipant) {
      const currentState = this.room.localParticipant.attributes['voice_assistant.state'];
      if (currentState !== state) {
        this.room.localParticipant!.setAttributes({
          'voice_assistant.state': state,
        });
        this.logger.debug(`voice_assistant.state updated from ${currentState} to ${state}`);
      }
    }
  }

  /// Truncates the data field of the event to the specified maxLength to avoid overwhelming logs
  /// with large amounts of base64 audio data.
  private loggableEvent(
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

  private sendClientCommand(command: proto.ClientEvent): void {
    const isAudio = command.type === 'input_audio_buffer.append';

    if (!this.connected || !this.ws) {
      if (!isAudio) this.logger.error('WebSocket is not connected');
      return;
    }

    if (!isAudio) {
      this.logger.debug(`-> ${JSON.stringify(this.loggableEvent(command))}`);
    }
    this.ws.send(JSON.stringify(command));
  }

  private handleServerEvent(event: proto.ServerEvent): void {
    this.logger.debug(`<- ${JSON.stringify(this.loggableEvent(event))}`);

    switch (event.type) {
      case 'session.created':
        this.setState(proto.State.LISTENING);
        break;
      case 'item.created':
        break;
      case 'response.audio_transcript.delta':
      case 'response.audio.delta':
        this.handleAddContent(event);
        break;
      case 'item.created':
        this.handleMessageAdded(event);
        break;
      case 'input_audio_buffer.speech_started':
        this.handleVadSpeechStarted(event);
        break;
      // case 'input_audio_transcription.stopped':
      //   break;
      case 'item.input_audio_transcription.completed':
        this.handleInputTranscribed(event);
        break;
      // case 'response.canceled':
      //   this.handleGenerationCanceled();
      //   break;
      case 'response.done':
        this.handleGenerationFinished(event);
        break;
      default:
        this.logger.warn(`Unknown server event: ${JSON.stringify(event)}`);
    }
  }

  private handleAddContent(
    event: proto.ResponseAudioDeltaEvent | proto.ResponseAudioTranscriptDeltaEvent,
  ): void {
    const trackSid = this.getLocalTrackSid();
    if (!this.room || !this.room.localParticipant || !trackSid || !this.agentPlayout) {
      log().error('Room or local participant not set');
      return;
    }

    if (!this.playingHandle || this.playingHandle.done) {
      const trFwd = new BasicTranscriptionForwarder(
        this.room,
        this.room?.localParticipant?.identity,
        trackSid,
        event.response_id,
      );

      this.setState(proto.State.SPEAKING);
      this.playingHandle = this.agentPlayout.play(event.response_id, trFwd);
      this.playingHandle.on('complete', () => {
        this.setState(proto.State.LISTENING);
      });
    }
    if (event.type === 'response.audio.delta') {
      this.playingHandle?.pushAudio(Buffer.from(event.delta, 'base64'));
    } else if (event.type === 'response.audio_transcript.delta') {
      this.playingHandle?.pushText(event.delta);
    }
  }

  private handleMessageAdded(event: proto.ConversationItemCreatedEvent): void {
    if (event.item.type === 'function_call') {
      const toolCall = event.item;
      this.options.functions[toolCall.name].execute(toolCall.arguments).then((content) => {
        this.thinking = false;
        this.sendClientCommand({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: toolCall.call_id,
            output: content,
          },
        });
        this.sendClientCommand({
          type: 'response.create',
          response: {},
        });
      });
    }
  }

  private handleInputTranscribed(
    event: proto.ConversationItemInputAudioTranscriptionCompletedEvent,
  ): void {
    const messageId = event.item_id;
    const transcription = event.transcript;
    if (!messageId || transcription === undefined) {
      this.logger.error('Message ID or transcription not set');
      return;
    }
    const participantIdentity = this.linkedParticipant?.identity;
    const trackSid = this.subscribedTrack?.sid;
    if (participantIdentity && trackSid) {
      this.publishTranscription(participantIdentity, trackSid, transcription, true, messageId);
    } else {
      this.logger.error('Participant or track not set');
    }
  }

  private handleGenerationFinished(event: proto.ResponseDoneEvent): void {
    if (
      event.response.status === 'incomplete' &&
      event.response.status_details?.type === 'incomplete' &&
      event.response.status_details?.reason === 'interruption'
    ) {
      if (this.playingHandle && !this.playingHandle.done) {
        this.playingHandle.interrupt();
        this.sendClientCommand({
          type: 'conversation.item.truncate',
          item_id: this.playingHandle.messageId,
          content_index: 0, // ignored for now (see OAI docs)
          audio_end_ms: (this.playingHandle.playedAudioSamples * 1000) / proto.SAMPLE_RATE,
        });
      }
    } else if (event.response.status !== 'completed') {
      log().warn(`assistant turn finished unexpectedly reason ${event.response.status}`);
    }

    if (this.playingHandle && !this.playingHandle.interrupted) {
      this.playingHandle.endInput();
    }
  }

  private handleVadSpeechStarted(event: proto.InputAudioBufferSpeechStartedEvent): void {
    const messageId = event.item_id;
    const participantIdentity = this.linkedParticipant?.identity;
    const trackSid = this.subscribedTrack?.sid;
    if (participantIdentity && trackSid && messageId) {
      this.publishTranscription(participantIdentity, trackSid, '', false, messageId);
    } else {
      this.logger.error('Participant or track or itemId not set');
    }
  }

  private linkParticipant(participantIdentity: string): void {
    if (!this.room) {
      this.logger.error('Room is not set');
      return;
    }

    this.linkedParticipant = this.room.remoteParticipants.get(participantIdentity) || null;
    if (!this.linkedParticipant) {
      this.logger.error(`Participant with identity ${participantIdentity} not found`);
      return;
    }

    if (this.linkedParticipant.trackPublications.size > 0) {
      this.subscribeToMicrophone();
    } else {
      this.room.on(RoomEvent.TrackPublished, () => {
        this.subscribeToMicrophone();
      });
    }
  }

  private subscribeToMicrophone(): void {
    const readAudioStreamTask = async (audioStream: AudioStream) => {
      const bstream = new AudioByteStream(
        proto.SAMPLE_RATE,
        proto.NUM_CHANNELS,
        proto.INPUT_PCM_FRAME_SIZE,
      );

      audioStream.on(AudioStreamEvent.FrameReceived, (ev: AudioFrameEvent) => {
        const audioData = ev.frame.data;
        for (const frame of bstream.write(audioData.buffer)) {
          this.sendClientCommand({
            type: 'input_audio_buffer.append',
            audio: Buffer.from(frame.data.buffer).toString('base64'),
          });
        }
      });
    };

    if (!this.linkedParticipant) {
      this.logger.error('Participant is not set');
      return;
    }

    for (const publication of this.linkedParticipant.trackPublications.values()) {
      if (publication.source !== TrackSource.SOURCE_MICROPHONE) {
        continue;
      }

      if (!publication.subscribed) {
        publication.setSubscribed(true);
      }

      const track = publication.track;

      if (track && track !== this.subscribedTrack) {
        this.subscribedTrack = track!;
        if (this.readMicroTask) {
          this.readMicroTask.cancel();
        }

        let cancel: () => void;
        this.readMicroTask = {
          promise: new Promise<void>((resolve, reject) => {
            cancel = () => {
              // Cleanup logic here
              reject(new Error('Task cancelled'));
            };
            readAudioStreamTask(new AudioStream(track, proto.SAMPLE_RATE, proto.NUM_CHANNELS))
              .then(resolve)
              .catch(reject);
          }),
          cancel: () => cancel(),
        };
      }
    }
  }

  private getLocalTrackSid(): string | null {
    if (!this.localTrackSid && this.room && this.room.localParticipant) {
      this.localTrackSid = findMicroTrackId(this.room, this.room.localParticipant?.identity);
    }
    return this.localTrackSid;
  }

  private publishTranscription(
    participantIdentity: string,
    trackSid: string,
    text: string,
    isFinal: boolean,
    id: string,
  ): void {
    // Log all parameters
    log().info('Publishing transcription', {
      participantIdentity,
      trackSid,
      text,
      isFinal,
      id,
    });
    if (!this.room?.localParticipant) {
      log().error('Room or local participant not set');
      return;
    }

    this.room.localParticipant.publishTranscription({
      participantIdentity,
      trackSid,
      segments: [
        {
          text,
          final: isFinal,
          id,
          startTime: BigInt(0),
          endTime: BigInt(0),
          language: '',
        },
      ],
    });
  }
}

const tools = (ctx: llm.FunctionContext): proto.Tool[] =>
  Object.entries(ctx).map(([name, func]) => ({
    name,
    description: func.description,
    parameters: llm.oaiParams(func.parameters),
    type: 'function',
  }));
