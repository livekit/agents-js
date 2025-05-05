import {
  AudioFrame,
  AudioStream,
  ConnectionState,
  type NoiseCancellationOptions,
  ParticipantKind,
  type RemoteParticipant,
  type RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
} from '@livekit/rtc-node';
import { log } from '../log.js';
import { AgentSession } from './agent_session.js';

// Constants
const DEFAULT_PARTICIPANT_KINDS: ParticipantKind[] = [
  ParticipantKind.SIP,
  ParticipantKind.STANDARD,
];

const ATTRIBUTE_AGENT_STATE = 'agent-state';
const ATTRIBUTE_PUBLISH_ON_BEHALF = 'publish-on-behalf';

export interface AudioInput {
  track: MediaStreamTrack;
  sampleRate: number;
  numChannels: number;
}

// Input options
export interface RoomInputOptions {
  audioEnabled: boolean;
  audioSampleRate: number;
  audioNumChannels: number;
  noiseCancellation?: NoiseCancellationOptions;
  participantKinds?: ParticipantKind[];
  participantIdentity?: string;
}

// Participant audio input stream
export class ParticipantAudioInputStream {
  private room: Room;
  private sampleRate: number;
  private numChannels: number;
  private noiseCancellation?: NoiseCancellationOptions;
  private participantIdentity?: string;
  private audioStream?: AudioStream = undefined;
  private audioStreamPromise: Promise<AudioStream> | null = null;
  private audioStreamAvailiableResolver: (value: AudioStream) => void = () => {};
  private logger = log();

  constructor(
    room: Room,
    options: {
      sampleRate: number;
      numChannels: number;
      noiseCancellation?: NoiseCancellationOptions;
    },
  ) {
    this.room = room;
    this.sampleRate = options.sampleRate;
    this.numChannels = options.numChannels;
    this.noiseCancellation = options.noiseCancellation;

    this.room.on(RoomEvent.TrackSubscribed, this.onTrackAvailable.bind(this));
    this.room.on(RoomEvent.TrackUnpublished, this.onTrackUnavailable.bind(this));

    this.audioStreamPromise = new Promise((resolve, reject) => {
      this.audioStreamAvailiableResolver = resolve;
    });
  }

  private onTrackAvailable(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): boolean {
    this.logger.debug('++++++ onTrackAvailable +++++', track, publication, participant);
    if (this.participantIdentity && participant.identity !== this.participantIdentity) {
      return false;
    }

    this.logger.debug(' +++++++ setting up audio stream');

    this.audioStream = new AudioStream(track);
    this.audioStreamAvailiableResolver(this.audioStream);
    return true;
  }

  private onTrackUnavailable(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    if (this.participantIdentity && participant.identity !== this.participantIdentity) {
      return;
    }
  }

  async getAudioStream(): Promise<AudioStream> {
    if (!this.audioStream) {
      await this.audioStreamPromise;
    }
    return this.audioStream!;
  }

  async close(): Promise<void> {
    this.audioStream?.close();
  }
}

export class RoomIO {
  private agentSession: AgentSession;
  private room: Room;
  private participant: RemoteParticipant;
  private participantAudioInputStream: ParticipantAudioInputStream;
  private logger = log();

  constructor(agentSession: AgentSession, room: Room, participant: RemoteParticipant) {
    this.agentSession = agentSession;
    this.room = room;
    this.participant = participant;
    this.participantAudioInputStream = new ParticipantAudioInputStream(room, {
      sampleRate: 16000,
      numChannels: 1,
      noiseCancellation: {
        moduleId: 'default',
        options: {},
      },
    });
  }

  start() {
    this.logger.debug('++++++ starting roomIO +++++');
    this.agentSession.audioInput = this.participantAudioInputStream;
  }

  get audioInput(): ParticipantAudioInputStream | undefined {
    this.logger.debug('++++++ getting audioInput +++++');
    return this.audioInput;
  }
}
