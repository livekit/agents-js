// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  LocalTrackPublication,
  RemoteAudioTrack,
  RemoteParticipant,
  Room,
} from '@livekit/rtc-node';
import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { EventEmitter } from 'events';
import { AudioByteStream } from '../audio.js';
import type * as llm from '../llm/index.js';
import { log } from '../log.js';
import { BasicTranscriptionForwarder } from '../transcription.js';
import { findMicroTrackId } from '../utils.js';
import { AgentPlayout, type PlayoutHandle, proto } from './agent_playout.js';

type ImplOptions = {
  // functions: llm.FunctionContext;
};

/**
 * @internal
 * @beta
 */
export abstract class RealtimeSession extends EventEmitter {
  abstract queueMsg(msg: any): void;
  abstract defaultConversation: any;
}

/**
 * @internal
 * @beta
 */
export abstract class RealtimeModel {
  abstract session(options: any): RealtimeSession;
  abstract close(): Promise<void>;
}

/** @beta */
export class MultimodalAgent {
  model: RealtimeModel;
  options: ImplOptions;
  room: Room | null = null;
  linkedParticipant: RemoteParticipant | null = null;
  subscribedTrack: RemoteAudioTrack | null = null;
  readMicroTask: { promise: Promise<void>; cancel: () => void } | null = null;

  constructor({
    model,
    // functions = {},
  }: {
    model: RealtimeModel;
    functions?: llm.FunctionContext;
  }) {
    this.model = model;

    this.options = {
      // functions,
    };
  }

  private started: boolean = false;
  private participant: RemoteParticipant | string | null = null;
  private agentPublication: LocalTrackPublication | null = null;
  private localTrackSid: string | null = null;
  private localSource: AudioSource | null = null;
  private agentPlayout: AgentPlayout | null = null;
  private playingHandle: PlayoutHandle | undefined = undefined;
  private logger = log();
  private session: RealtimeSession | null = null;

  // get funcCtx(): llm.FunctionContext {
  //   return this.options.functions;
  // }
  // set funcCtx(ctx: llm.FunctionContext) {
  //   this.options.functions = ctx;
  //   this.options.sessionConfig.tools = tools(ctx);
  //   this.sendClientCommand({
  //     type: proto.ClientEventType.SessionUpdate,
  //     session: this.options.sessionConfig,
  //   });
  // }

  start(room: Room, participant: RemoteParticipant | string | null = null): Promise<void> {
    return new Promise(async (resolve, reject) => {
      if (this.started) {
        this.logger.warn('MultimodalAgent already started');
        resolve(); // TODO: throw error?
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

      this.localSource = new AudioSource(24000, 1);
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

      this.session = this.model.session({});

      this.session.on('response_content_added', (message: any) => {
        const trFwd = new BasicTranscriptionForwarder(
          this.room!,
          this.room!.localParticipant!.identity,
          this.getLocalTrackSid()!,
          message.responseId,
        );

        this.playingHandle = this.agentPlayout?.play(
          message.itemId,
          message.contentIndex,
          trFwd,
          message.textStream,
          message.audioStream,
        );
      });

      this.session.on('input_speech_committed', (ev: any) => {
        const participantIdentity = this.linkedParticipant?.identity;
        const trackSid = this.subscribedTrack?.sid;
        if (participantIdentity && trackSid) {
          this.publishTranscription(participantIdentity, trackSid, '', true, ev.itemId);
        } else {
          this.logger.error('Participant or track not set');
        }
      });

      this.session.on('input_speech_transcription_completed', (ev: any) => {
        const transcription = ev.transcript;
        const participantIdentity = this.linkedParticipant?.identity;
        const trackSid = this.subscribedTrack?.sid;
        if (participantIdentity && trackSid) {
          this.publishTranscription(participantIdentity, trackSid, transcription, true, ev.itemId);
        } else {
          this.logger.error('Participant or track not set');
        }
      });

      this.session.on('input_speech_started', () => {
        if (this.playingHandle && !this.playingHandle.done) {
          this.playingHandle.interrupt();

          this.session!.defaultConversation.item.truncate(
            this.playingHandle.itemId,
            this.playingHandle.contentIndex,
            Math.floor((this.playingHandle.audioSamples / 24000) * 1000),
          );

          this.playingHandle = undefined;
        }
      });
    });
  }

  // close() {
  //   if (!this.connected || !this.ws) return;
  //   this.logger.debug('stopping assistant');
  //   this.ws.close();
  // }

  // addUserMessage(text: string, generate: boolean = true): void {
  //   this.sendClientCommand({
  //     type: proto.ClientEventType.ConversationItemCreate,
  //     item: {
  //       type: 'message',
  //       role: 'user',
  //       content: [
  //         {
  //           type: 'text',
  //           text: text,
  //         },
  //       ],
  //     },
  //   });
  //   if (generate) {
  //     this.sendClientCommand({
  //       type: proto.ClientEventType.ResponseCreate,
  //       response: {},
  //     });
  //   }
  // }

  // private setState(state: proto.State) {
  //   // don't override thinking until done
  //   if (this.thinking) return;
  //   if (this.room?.isConnected && this.room.localParticipant) {
  //     const currentState = this.room.localParticipant.attributes['lk.agent.state'];
  //     if (currentState !== state) {
  //       this.room.localParticipant!.setAttributes({
  //         'lk.agent.state': state,
  //       });
  //       this.logger.debug(`lk.agent.state updated from ${currentState} to ${state}`);
  //     }
  //   }
  // }

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

      for await (const frame of audioStream) {
        const audioData = frame.data;
        for (const frame of bstream.write(audioData.buffer)) {
          this.session!.queueMsg({
            type: 'input_audio_buffer.append',
            audio: Buffer.from(frame.data.buffer).toString('base64'),
          });
        }
      }
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
    this.logger.info(
      `Publishing transcription ${participantIdentity} ${trackSid} ${text} ${isFinal} ${id}`,
    );
    if (!this.room?.localParticipant) {
      this.logger.error('Room or local participant not set');
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
