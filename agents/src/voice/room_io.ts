import {
  AudioFrame,
  AudioStream,
  type RemoteParticipant,
  type RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  TrackKind,
} from '@livekit/rtc-node';
import { ReadableStream, type UnderlyingSource } from 'node:stream/web';
import { log } from '../log.js';
import { AgentSession } from './agent_session.js';

/**
 * Typescript has removed the type definition that generates the async
 * iterator for ReadableStream, because Chrome has not implemented it yet.
 *
 * See https://github.com/DefinitelyTyped/DefinitelyTyped/discussions/65542#discussioncomment-6071004
 * for more details.
 *
 * Since we are only running this in node, we can use the any type to get around this.
 */
function asCompatibleStream<T>(stream: ReadableStream<T>): any {
  return stream;
}

class ParticipantAudioSource implements UnderlyingSource<AudioFrame> {
  private room: Room;
  private participantIdentity?: string;
  private audioStream?: AudioStream;
  private controller?: ReadableStreamDefaultController<AudioFrame>;
  private isCancelled = false;
  private logger = log();

  constructor(room: Room, participantIdentity?: string) {
    this.room = room;
    this.participantIdentity = participantIdentity;

    this.room.on(RoomEvent.TrackSubscribed, this.onTrackAvailable.bind(this));
  }

  start(controller: ReadableStreamDefaultController<AudioFrame>): void | Promise<void> {
    this.controller = controller;
  }

  cancel(_reason?: any): void | Promise<void> {
    this.cleanup();
  }

  private cleanup(): void {
    this.isCancelled = true;
    this.logger.debug('Participant audio source cancelled');

    if (this.audioStream) {
      this.audioStream.cancel();
      this.audioStream = undefined;
    }

    this.room.off(RoomEvent.TrackSubscribed, this.onTrackAvailable.bind(this));
  }

  private onTrackAvailable(
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): boolean {
    this.logger.debug('Track available for participant', participant.identity);

    if (this.participantIdentity && participant.identity !== this.participantIdentity) {
      return false;
    }

    if (track.kind !== TrackKind.KIND_AUDIO) {
      return false;
    }

    if (this.audioStream || this.isCancelled || !this.controller) {
      return false;
    }

    return this.setupAudioStream(track, participant);
  }

  private setupAudioStream(track: RemoteTrack, participant: RemoteParticipant): boolean {
    this.logger.debug('Setting up audio stream for participant', participant.identity);
    this.audioStream = new AudioStream(track, {
      sampleRate: 16000,
      numChannels: 1,
    });

    this.readAudioFrames().catch((err) => {
      this.logger.error('Error reading audio frames', err);
      if (this.controller && !this.isCancelled) {
        this.controller.error(err);
      }
    });

    return true;
  }

  private async readAudioFrames(): Promise<void> {
    if (!this.audioStream || !this.controller || this.isCancelled) {
      this.logger.warn('Audio stream not available');
      return;
    }

    try {
      for await (const frame of asCompatibleStream(this.audioStream)) {
        if (this.isCancelled) {
          break;
        }

        this.controller.enqueue(frame);
      }
    } catch (err) {
      this.logger.error('Error while reading audio frames', err);
      if (!this.isCancelled && this.controller) {
        this.controller.error(err);
      }
    } finally {
      if (!this.isCancelled && this.controller) {
        this.controller.close();
      }
    }
  }
}

export class ParticipantAudioInputStream extends ReadableStream<AudioFrame> {
  constructor(room: Room, participantIdentity?: string) {
    super(new ParticipantAudioSource(room, participantIdentity));
  }
}

export class RoomIO {
  private agentSession: AgentSession;
  private participantAudioInputStream: ReadableStream<AudioFrame>;
  private logger = log();

  constructor(agentSession: AgentSession, room: Room) {
    this.agentSession = agentSession;
    this.participantAudioInputStream = new ParticipantAudioInputStream(room);
  }

  start() {
    this.agentSession.audioInput = asCompatibleStream(this.participantAudioInputStream);
  }
}
