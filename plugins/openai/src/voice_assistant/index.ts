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

export const defaultSessionConfig: proto.SessionConfig = {
  turn_detection: 'server_vad',
  input_audio_format: proto.AudioFormat.PCM16,
  transcribe_input: true,
  vad: {
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 200,
  },
};

export const defaultConversationConfig: proto.ConversationConfig = {
  system_message: 'You are a helpful assistant.',
  voice: proto.Voice.ALLOY,
  subscribe_to_user_audio: true,
  output_audio_format: proto.AudioFormat.PCM16,
  tools: [],
  tool_choice: proto.ToolChoice.AUTO,
  temperature: 0.8,
  max_tokens: 2048,
  disable_audio: false,
  transcribe_input: true,
};

type ImplOptions = {
  apiKey: string;
  sessionConfig: proto.SessionConfig;
  conversationConfig: proto.ConversationConfig;
  functions: llm.FunctionContext;
};

export class VoiceAssistant {
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
    sessionConfig?: proto.SessionConfig;
    conversationConfig?: proto.ConversationConfig;
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
      room.on(RoomEvent.TrackPublished, () => {
        this.subscribeToMicrophone();
      });
      room.on(RoomEvent.TrackSubscribed, () => {
        this.subscribeToMicrophone();
      });

      this.room = room;
      this.participant = participant;
      this.setState(proto.State.INITIALIZING);

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

      this.ws = new WebSocket(proto.API_URL, {
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
        },
      });

      this.ws.onopen = () => {
        this.connected = true;
        this.sendClientCommand({
          event: proto.ClientEventType.UPDATE_SESSION_CONFIG,
          ...this.options.sessionConfig,
        });
        this.sendClientCommand({
          event: proto.ClientEventType.UPDATE_CONVERSATION_CONFIG,
          ...this.options.conversationConfig,
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

  addUserMessage(text: string, generate: boolean = true): void {
    this.sendClientCommand({
      event: proto.ClientEventType.ADD_MESSAGE,
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: text,
          },
        ],
      },
    });
    if (generate) {
      this.sendClientCommand({
        event: proto.ClientEventType.GENERATE,
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

    if (untypedEvent.data && typeof untypedEvent.data === 'string') {
      const truncatedData =
        untypedEvent.data.slice(0, maxLength) + (untypedEvent.data.length > maxLength ? '…' : '');
      return { ...untypedEvent, data: truncatedData };
    }
    return untypedEvent;
  }

  private sendClientCommand(command: proto.ClientEvent): void {
    const isAudio = command.event === proto.ClientEventType.ADD_USER_AUDIO;

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

    switch (event.event) {
      case proto.ServerEventType.START_SESSION:
        this.setState(proto.State.LISTENING);
        break;
      case proto.ServerEventType.ADD_MESSAGE:
        break;
      case proto.ServerEventType.ADD_CONTENT:
        this.handleAddContent(event);
        break;
      case proto.ServerEventType.MESSAGE_ADDED:
        this.handleMessageAdded(event);
        break;
      case proto.ServerEventType.VAD_SPEECH_STARTED:
        this.handleVadSpeechStarted(event);
        break;
      case proto.ServerEventType.VAD_SPEECH_STOPPED:
        break;
      case proto.ServerEventType.INPUT_TRANSCRIBED:
        this.handleInputTranscribed(event);
        break;
      case proto.ServerEventType.GENERATION_CANCELED:
        this.handleGenerationCanceled();
        break;
      case proto.ServerEventType.GENERATION_FINISHED:
        this.handleGenerationFinished(event);
        break;
      default:
        this.logger.warn(`Unknown server event: ${JSON.stringify(event)}`);
    }
  }

  private handleAddContent(event: proto.ServerEvent): void {
    if (event.event !== proto.ServerEventType.ADD_CONTENT) return;

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
        event.message_id,
      );

      this.setState(proto.State.SPEAKING);
      this.playingHandle = this.agentPlayout.play(event.message_id, trFwd);
      this.playingHandle.on('complete', () => {
        this.setState(proto.State.LISTENING);
      });
    }
    switch (event.type) {
      case 'audio':
        this.playingHandle?.pushAudio(Buffer.from(event.data, 'base64'));
        break;
      case 'text':
        this.playingHandle?.pushText(event.data);
        break;
      default:
        this.logger.warn(`Unknown content event type: ${event.type}`);
        break;
    }
  }

  private handleMessageAdded(event: proto.ServerEvent): void {
    if (event.event !== proto.ServerEventType.MESSAGE_ADDED) return;
    for (const toolCall of event.content || []) {
      this.options.functions[toolCall.name].execute(toolCall.arguments).then((content) => {
        this.thinking = false;
        this.sendClientCommand({
          event: proto.ClientEventType.ADD_MESSAGE,
          message: {
            role: 'tool',
            tool_call_id: toolCall.tool_call_id,
            content,
          },
        });
        this.sendClientCommand({
          event: proto.ClientEventType.GENERATE,
        });
      });
      break;
    }
  }

  private handleInputTranscribed(event: proto.ServerEvent): void {
    if (event.event !== proto.ServerEventType.INPUT_TRANSCRIBED) return;
    const messageId = event.message_id;
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

  private handleGenerationCanceled(): void {
    if (this.playingHandle && !this.playingHandle.done) {
      this.playingHandle.interrupt();
      this.sendClientCommand({
        event: proto.ClientEventType.TRUNCATE_CONTENT,
        message_id: this.playingHandle.messageId,
        index: 0, // ignored for now (see OAI docs)
        text_chars: this.playingHandle.publishedTextChars(),
        audio_samples: this.playingHandle.playedAudioSamples,
      });
    }
  }

  private handleGenerationFinished(event: proto.ServerEvent): void {
    if (event.event !== proto.ServerEventType.GENERATION_FINISHED) return;
    if (event.reason !== 'interrupt' && event.reason !== 'stop') {
      log().warn(`assistant turn finished unexpectedly reason ${event.reason}`);
    }

    if (this.playingHandle && !this.playingHandle.interrupted) {
      this.playingHandle.endInput();
    }
  }

  private handleVadSpeechStarted(event: proto.ServerEvent): void {
    if (event.event !== proto.ServerEventType.VAD_SPEECH_STARTED) return;
    const messageId = event.message_id;
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
    this.subscribeToMicrophone();
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
            event: proto.ClientEventType.ADD_USER_AUDIO,
            data: Buffer.from(frame.data.buffer).toString('base64'),
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
    type: 'function',
    function: {
      name,
      description: func.description,
      parameters: llm.oaiParams(func.parameters),
    },
  }));
