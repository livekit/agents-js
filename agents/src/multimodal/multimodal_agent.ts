// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  LocalTrackPublication,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
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
import { EventEmitter } from 'node:events';
import { AudioByteStream } from '../audio.js';
import * as llm from '../llm/index.js';
import { log } from '../log.js';
import type { MultimodalLLMMetrics } from '../metrics/base.js';
import { BasicTranscriptionForwarder } from '../transcription.js';
import { findMicroTrackId } from '../utils.js';
import { AgentPlayout, type PlayoutHandle } from './agent_playout.js';

/**
 * @internal
 * @beta
 */
export abstract class RealtimeSession extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract conversation: any; // openai.realtime.Conversation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract inputAudioBuffer: any; // openai.realtime.InputAudioBuffer
  abstract fncCtx: llm.FunctionContext | undefined;
}

/**
 * @internal
 * @beta
 */
export abstract class RealtimeModel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract session(options: any): RealtimeSession; // openai.realtime.ModelOptions
  abstract close(): Promise<void>;
  abstract sampleRate: number;
  abstract numChannels: number;
  abstract inFrameSize: number;
  abstract outFrameSize: number;
}

export type AgentState = 'initializing' | 'thinking' | 'listening' | 'speaking';
export const AGENT_STATE_ATTRIBUTE = 'lk.agent.state';

/** @beta */
export class MultimodalAgent extends EventEmitter {
  model: RealtimeModel;
  room: Room | null = null;
  linkedParticipant: RemoteParticipant | null = null;
  subscribedTrack: RemoteAudioTrack | null = null;
  readMicroTask: Promise<void> | null = null;

  constructor({
    model,
    chatCtx,
    fncCtx,
  }: {
    model: RealtimeModel;
    chatCtx?: llm.ChatContext;
    fncCtx?: llm.FunctionContext;
  }) {
    super();
    this.model = model;
    this.#chatCtx = chatCtx;
    this.#fncCtx = fncCtx;
  }

  #participant: RemoteParticipant | string | null = null;
  #agentPublication: LocalTrackPublication | null = null;
  #localTrackSid: string | null = null;
  #localSource: AudioSource | null = null;
  #agentPlayout: AgentPlayout | null = null;
  #playingHandle: PlayoutHandle | undefined = undefined;
  #logger = log();
  #session: RealtimeSession | null = null;
  #fncCtx: llm.FunctionContext | undefined = undefined;
  #chatCtx: llm.ChatContext | undefined = undefined;

  #_started: boolean = false;
  #_pendingFunctionCalls: Set<string> = new Set();
  #_speaking: boolean = false;

  get fncCtx(): llm.FunctionContext | undefined {
    return this.#fncCtx;
  }

  set fncCtx(ctx: llm.FunctionContext | undefined) {
    this.#fncCtx = ctx;
    if (this.#session) {
      this.#session.fncCtx = ctx;
    }
  }

  get #pendingFunctionCalls(): Set<string> {
    return this.#_pendingFunctionCalls;
  }

  set #pendingFunctionCalls(calls: Set<string>) {
    this.#_pendingFunctionCalls = calls;
    this.#updateState();
  }

  get #speaking(): boolean {
    return this.#_speaking;
  }

  set #speaking(isSpeaking: boolean) {
    this.#_speaking = isSpeaking;
    this.#updateState();
  }

  get #started(): boolean {
    return this.#_started;
  }

  set #started(started: boolean) {
    this.#_started = started;
    this.#updateState();
  }

  start(
    room: Room,
    participant: RemoteParticipant | string | null = null,
  ): Promise<RealtimeSession> {
    return new Promise(async (resolve, reject) => {
      if (this.#started) {
        reject(new Error('MultimodalAgent already started'));
      }
      this.#updateState();

      room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        // automatically link to the first participant that connects, if not already linked
        if (this.linkedParticipant) {
          return;
        }
        this.#linkParticipant(participant.identity);
      });
      room.on(
        RoomEvent.TrackPublished,
        (trackPublication: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (
            this.linkedParticipant &&
            participant.identity === this.linkedParticipant.identity &&
            trackPublication.source === TrackSource.SOURCE_MICROPHONE &&
            !trackPublication.subscribed
          ) {
            trackPublication.setSubscribed(true);
          }
        },
      );
      room.on(RoomEvent.TrackSubscribed, this.#handleTrackSubscription.bind(this));

      this.room = room;
      this.#participant = participant;

      this.#localSource = new AudioSource(this.model.sampleRate, this.model.numChannels);
      this.#agentPlayout = new AgentPlayout(
        this.#localSource,
        this.model.sampleRate,
        this.model.numChannels,
        this.model.inFrameSize,
        this.model.outFrameSize,
      );
      const onPlayoutStarted = () => {
        this.emit('agent_started_speaking');
        this.#speaking = true;
      };

      const onPlayoutStopped = (interrupted: boolean) => {
        this.emit('agent_stopped_speaking');
        this.#speaking = false;
        if (this.#playingHandle) {
          let text = this.#playingHandle.transcriptionFwd.text;
          if (interrupted) {
            text += '…';
          }
          const msg = llm.ChatMessage.create({
            role: llm.ChatRole.ASSISTANT,
            text,
          });

          if (interrupted) {
            this.emit('agent_speech_interrupted', msg);
          } else {
            this.emit('agent_speech_committed', msg);
          }
          this.#logger.child({ transcription: text, interrupted }).debug('committed agent speech');
        }
      };

      this.#agentPlayout.on('playout_started', onPlayoutStarted);
      this.#agentPlayout.on('playout_stopped', onPlayoutStopped);

      const track = LocalAudioTrack.createAudioTrack('assistant_voice', this.#localSource);
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      this.#agentPublication = (await room.localParticipant?.publishTrack(track, options)) || null;
      if (!this.#agentPublication) {
        this.#logger.error('Failed to publish track');
        reject(new Error('Failed to publish track'));
        return;
      }

      await this.#agentPublication.waitForSubscription();

      if (participant) {
        if (typeof participant === 'string') {
          this.#linkParticipant(participant);
        } else {
          this.#linkParticipant(participant.identity);
        }
      } else {
        // No participant specified, try to find the first participant in the room
        for (const participant of room.remoteParticipants.values()) {
          this.#linkParticipant(participant.identity);
          break;
        }
      }

      this.#session = this.model.session({ fncCtx: this.#fncCtx, chatCtx: this.#chatCtx });
      this.#started = true;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.#session.on('response_content_added', (message: any) => {
        // openai.realtime.RealtimeContent
        const trFwd = new BasicTranscriptionForwarder(
          this.room!,
          this.room!.localParticipant!.identity,
          this.#getLocalTrackSid()!,
          message.responseId,
        );

        const handle = this.#agentPlayout?.play(
          message.itemId,
          message.contentIndex,
          trFwd,
          message.textStream,
          message.audioStream,
        );
        this.#playingHandle = handle;
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.#session.on('input_speech_committed', (ev: any) => {
        // openai.realtime.InputSpeechCommittedEvent
        const participantIdentity = this.linkedParticipant?.identity;
        const trackSid = this.subscribedTrack?.sid;
        if (participantIdentity && trackSid) {
          this.#publishTranscription(participantIdentity, trackSid, '…', false, ev.itemId);
        } else {
          this.#logger.error('Participant or track not set');
        }
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.#session.on('input_speech_transcription_completed', (ev: any) => {
        // openai.realtime.InputSpeechTranscriptionCompletedEvent
        const transcription = ev.transcript;
        const participantIdentity = this.linkedParticipant?.identity;
        const trackSid = this.subscribedTrack?.sid;
        if (participantIdentity && trackSid) {
          this.#publishTranscription(participantIdentity, trackSid, transcription, true, ev.itemId);
        } else {
          this.#logger.error('Participant or track not set');
        }
        const userMsg = llm.ChatMessage.create({
          role: llm.ChatRole.USER,
          text: transcription,
        });
        this.emit('user_speech_committed', userMsg);
        this.#logger.child({ transcription }).debug('committed user speech');
      });

      this.#session.on('input_speech_started', (ev: any) => {
        this.emit('user_started_speaking');
        if (this.#playingHandle && !this.#playingHandle.done) {
          this.#playingHandle.interrupt();

          this.#session!.conversation.item.truncate(
            this.#playingHandle.itemId,
            this.#playingHandle.contentIndex,
            Math.floor((this.#playingHandle.audioSamples / 24000) * 1000),
          );

          this.#playingHandle = undefined;
        }

        const participantIdentity = this.linkedParticipant?.identity;
        const trackSid = this.subscribedTrack?.sid;
        if (participantIdentity && trackSid) {
          this.#publishTranscription(participantIdentity, trackSid, '…', false, ev.itemId);
        }
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      this.#session.on('input_speech_stopped', (ev: any) => {
        this.emit('user_stopped_speaking');
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.#session.on('function_call_started', (ev: any) => {
        this.#pendingFunctionCalls.add(ev.callId);
        this.#updateState();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.#session.on('function_call_completed', (ev: any) => {
        this.#pendingFunctionCalls.delete(ev.callId);
        this.#updateState();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.#session.on('function_call_failed', (ev: any) => {
        this.#pendingFunctionCalls.delete(ev.callId);
        this.#updateState();
      });

      this.#session.on('metrics_collected', (metrics: MultimodalLLMMetrics) => {
        this.emit('metrics_collected', metrics);
      });

      resolve(this.#session);
    });
  }

  #linkParticipant(participantIdentity: string): void {
    if (!this.room) {
      this.#logger.error('Room is not set');
      return;
    }

    this.linkedParticipant = this.room.remoteParticipants.get(participantIdentity) || null;
    if (!this.linkedParticipant) {
      this.#logger.error(`Participant with identity ${participantIdentity} not found`);
      return;
    }

    if (this.linkedParticipant.trackPublications.size > 0) {
      this.#subscribeToMicrophone();
    }

    // also check if already subscribed
    for (const publication of this.linkedParticipant.trackPublications.values()) {
      if (publication.source === TrackSource.SOURCE_MICROPHONE && publication.track) {
        this.#handleTrackSubscription(publication.track, publication, this.linkedParticipant);
        break;
      }
    }
  }

  #subscribeToMicrophone(): void {
    if (!this.linkedParticipant) {
      this.#logger.error('Participant is not set');
      return;
    }

    let microphonePublication: RemoteTrackPublication | undefined = undefined;
    for (const publication of this.linkedParticipant.trackPublications.values()) {
      if (publication.source === TrackSource.SOURCE_MICROPHONE) {
        microphonePublication = publication;
        break;
      }
    }
    if (!microphonePublication) {
      return;
    }

    if (!microphonePublication.subscribed) {
      microphonePublication.setSubscribed(true);
    }
  }

  #handleTrackSubscription(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) {
    if (
      publication.source !== TrackSource.SOURCE_MICROPHONE ||
      participant.identity !== this.linkedParticipant?.identity
    ) {
      return;
    }
    const readAudioStreamTask = async (audioStream: AudioStream) => {
      const bstream = new AudioByteStream(
        this.model.sampleRate,
        this.model.numChannels,
        this.model.inFrameSize,
      );

      for await (const frame of audioStream) {
        const audioData = frame.data;
        for (const frame of bstream.write(audioData.buffer)) {
          this.#session!.inputAudioBuffer.append(frame);
        }
      }
    };
    this.subscribedTrack = track;

    this.readMicroTask = new Promise<void>((resolve, reject) => {
      readAudioStreamTask(new AudioStream(track, this.model.sampleRate, this.model.numChannels))
        .then(resolve)
        .catch(reject);
    });
  }

  #getLocalTrackSid(): string | null {
    if (!this.#localTrackSid && this.room && this.room.localParticipant) {
      this.#localTrackSid = findMicroTrackId(this.room, this.room.localParticipant?.identity);
    }
    return this.#localTrackSid;
  }

  #publishTranscription(
    participantIdentity: string,
    trackSid: string,
    text: string,
    isFinal: boolean,
    id: string,
  ): void {
    this.#logger.debug(
      `Publishing transcription ${participantIdentity} ${trackSid} ${text} ${isFinal} ${id}`,
    );
    if (!this.room?.localParticipant) {
      this.#logger.error('Room or local participant not set');
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

  #updateState() {
    let newState: AgentState = 'initializing';
    if (this.#pendingFunctionCalls.size > 0) {
      newState = 'thinking';
    } else if (this.#speaking) {
      newState = 'speaking';
    } else if (this.#started) {
      newState = 'listening';
    }

    this.#setState(newState);
  }

  #setState(state: AgentState) {
    if (this.room?.isConnected && this.room.localParticipant) {
      const currentState = this.room.localParticipant.attributes[AGENT_STATE_ATTRIBUTE];
      if (currentState !== state) {
        this.room.localParticipant.setAttributes({
          [AGENT_STATE_ATTRIBUTE]: state,
        });
        this.#logger.debug(`${AGENT_STATE_ATTRIBUTE}: ${currentState} ->${state}`);
      }
    }
  }
}
