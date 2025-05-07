import {
  AudioStream,
  type RemoteParticipant,
  type RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
} from '@livekit/rtc-node';
import { log } from '../log.js';
import { AgentSession } from './agent_session.js';

export class ParticipantAudioInputStream {
  private room: Room;
  private participantIdentity?: string;
  private audioStream?: AudioStream = undefined;
  private audioStreamPromise: Promise<AudioStream> | null = null;
  private audioStreamAvailiableResolver: (value: AudioStream) => void = () => {};
  private logger = log();

  constructor(room: Room) {
    this.room = room;

    this.room.on(RoomEvent.TrackSubscribed, this.onTrackAvailable.bind(this));
    this.room.on(RoomEvent.TrackUnpublished, this.onTrackUnavailable.bind(this));

    this.audioStreamPromise = new Promise((resolve, reject) => {
      this.audioStreamAvailiableResolver = resolve;
    });
  }

  private onTrackAvailable(
    track: RemoteTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): boolean {
    if (this.participantIdentity && participant.identity !== this.participantIdentity) {
      return false;
    }
    this.audioStream = new AudioStream(track);
    this.audioStreamAvailiableResolver(this.audioStream);
    return true;
  }

  private onTrackUnavailable(
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    if (this.participantIdentity && participant.identity !== this.participantIdentity) {
      return;
    }
  }

  async getAudioStream(): Promise<AudioStream> {
    if (!this.audioStream) {
      // TODO(shubhra): getting rid of these logs? doesn't start the audio stream? wtf?
      this.logger.debug('Waiting for audio stream');
      await this.audioStreamPromise;
    }
    this.logger.debug('Audio stream available');
    return this.audioStream!;
  }

  async close(): Promise<void> {
    this.audioStream?.close();
  }
}

export class RoomIO {
  private agentSession: AgentSession;
  private participantAudioInputStream: ParticipantAudioInputStream;
  private logger = log();

  constructor(agentSession: AgentSession, room: Room) {
    this.agentSession = agentSession;
    this.participantAudioInputStream = new ParticipantAudioInputStream(room);
  }

  start() {
    this.agentSession.audioInput = this.participantAudioInputStream;
  }

  get audioInput(): ParticipantAudioInputStream {
    return this.participantAudioInputStream;
  }
}
