// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  LocalParticipant,
  Participant,
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
  TextStreamWriter,
} from '@livekit/rtc-node';
import { type LocalTrackPublication, RoomEvent, TrackSource } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import {
  ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID,
  ATTRIBUTE_TRANSCRIPTION_TRACK_ID,
  TOPIC_TRANSCRIPTION,
} from '../../constants.js';
import { log } from '../../log.js';
import { Task } from '../../utils.js';

function findMicrophoneTrackId(room: Room, identity: string): string {
  let p: Participant | LocalParticipant | null = room.remoteParticipants.get(identity) ?? null;
  if (identity === room.localParticipant?.identity) {
    p = room.localParticipant;
  }

  if (p === null) {
    throw new Error(`Participant ${identity} not found`);
  }

  for (const track of p.trackPublications.values()) {
    if (track.source === TrackSource.SOURCE_MICROPHONE && track.sid) {
      // find the first microphone track
      return track.sid;
    }
  }

  throw new Error(`Participant ${identity} does not have a microphone track`);
}

export abstract class TextOutput {
  abstract captureText(text: string): Promise<void>;
  abstract flush(): void;
}

abstract class BaseParticipantTranscriptionOutput extends TextOutput {
  protected room: Room;
  protected isDeltaStream: boolean;
  protected participantIdentity?: string;
  protected trackId?: string;
  protected capturing: boolean = false;
  protected latestText: string = '';
  protected currentId: string = this.generateCurrentId();
  protected logger = log();

  constructor(room: Room, isDeltaStream: boolean, participant?: Participant | string) {
    super();
    this.room = room;
    this.isDeltaStream = isDeltaStream;

    this.room.on(RoomEvent.TrackPublished, this.onTrackPublished);
    this.room.on(RoomEvent.LocalTrackPublished, this.onLocalTrackPublished);

    this.setParticipant(participant);
  }

  setParticipant(participant?: Participant | string) {
    if (!participant) {
      return;
    }

    if (typeof participant === 'string') {
      this.participantIdentity = participant;
    } else {
      this.participantIdentity = participant.identity;
    }

    try {
      this.trackId = findMicrophoneTrackId(this.room, this.participantIdentity);
    } catch (error) {
      // track id is optional for TextStream when audio is not published
      this.logger.debug(error, 'failed to find microphone track id');
    }

    this.flush();
    this.resetState();
  }

  protected onTrackPublished = (track: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (
      !this.participantIdentity ||
      participant.identity !== this.participantIdentity ||
      track.source !== TrackSource.SOURCE_MICROPHONE
    ) {
      return;
    }

    this.trackId = track.sid;
  };

  protected onLocalTrackPublished = (track: LocalTrackPublication) => {
    if (
      !this.participantIdentity ||
      this.participantIdentity !== this.room.localParticipant?.identity ||
      track.source !== TrackSource.SOURCE_MICROPHONE
    ) {
      return;
    }

    this.trackId = track.sid;
  };

  protected generateCurrentId(): string {
    return 'SG_' + randomUUID();
  }

  protected resetState() {
    this.currentId = this.generateCurrentId();
    this.capturing = false;
    this.latestText = '';
  }

  async captureText(text: string) {
    if (!this.participantIdentity) {
      return;
    }

    this.latestText = text;
    await this.handleCaptureText(text);
  }

  flush() {
    if (this.participantIdentity === null || !this.capturing) {
      return;
    }

    this.capturing = false;
    this.handleFlush();
  }

  protected abstract handleCaptureText(text: string): Promise<void>;
  protected abstract handleFlush(): void;
}

export class ParticipantTranscriptionOutput extends BaseParticipantTranscriptionOutput {
  private writer: TextStreamWriter | null = null;
  private flushTask: Task<void> | null = null;

  protected async handleCaptureText(text: string): Promise<void> {
    if (this.flushTask && !this.flushTask.done) {
      await this.flushTask.result;
    }

    if (!this.capturing) {
      this.resetState();
      this.capturing = true;
    }

    try {
      if (this.room.isConnected) {
        if (this.isDeltaStream) {
          // reuse the existing writer
          if (this.writer === null) {
            this.writer = await this.createTextWriter();
          }
          await this.writer.write(text);
        } else {
          const tmpWriter = await this.createTextWriter();
          await tmpWriter.write(text);
          await tmpWriter.close();
        }
      }
    } catch (error) {
      this.logger.error(error, 'failed to publish transcription');
    }
  }

  protected handleFlush() {
    const currWriter = this.writer;
    this.writer = null;
    this.flushTask = Task.from((controller) => this.flushTaskImpl(currWriter, controller.signal));
  }

  private async createTextWriter(attributes?: Record<string, string>): Promise<TextStreamWriter> {
    if (!this.participantIdentity) {
      throw new Error('participantIdentity not found');
    }

    if (!this.room.localParticipant) {
      throw new Error('localParticipant not found');
    }

    if (!attributes) {
      attributes = {
        ATTRIBUTE_TRANSCRIPTION_FINAL: 'false',
      };
      if (this.trackId) {
        attributes[ATTRIBUTE_TRANSCRIPTION_TRACK_ID] = this.trackId;
      }
      attributes[ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID] = this.currentId;
    }

    return await this.room.localParticipant.streamText({
      topic: TOPIC_TRANSCRIPTION,
      senderIdentity: this.participantIdentity,
      attributes,
    });
  }

  private async flushTaskImpl(writer: TextStreamWriter | null, signal: AbortSignal): Promise<void> {
    const attributes: Record<string, string> = {
      ATTRIBUTE_TRANSCRIPTION_FINAL: 'true',
    };
    if (this.trackId) {
      attributes[ATTRIBUTE_TRANSCRIPTION_TRACK_ID] = this.trackId;
    }

    const abortPromise = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve());
    });

    try {
      if (this.room.isConnected) {
        if (this.isDeltaStream) {
          if (writer) {
            await Promise.race([writer.close(), abortPromise]);
          }
        } else {
          const tmpWriter = await Promise.race([this.createTextWriter(attributes), abortPromise]);
          if (signal.aborted || !tmpWriter) {
            return;
          }
          await Promise.race([tmpWriter.write(this.latestText), abortPromise]);
          if (signal.aborted) {
            return;
          }
          await Promise.race([tmpWriter.close(), abortPromise]);
        }
      }
    } catch (error) {
      this.logger.error(error, 'failed to publish transcription');
    }
  }
}

export class ParticipantLegacyTranscriptionOutput extends BaseParticipantTranscriptionOutput {
  private pushedText: string = '';
  private flushTask: Promise<void> | null = null;

  protected async handleCaptureText(text: string): Promise<void> {
    if (!this.trackId) {
      return;
    }

    if (this.flushTask) {
      await this.flushTask;
    }

    if (!this.capturing) {
      this.resetState();
      this.capturing = true;
    }

    if (this.isDeltaStream) {
      this.pushedText += text;
    } else {
      this.pushedText = text;
    }

    await this.publishTranscription(this.currentId, this.pushedText, false);
  }

  protected handleFlush() {
    if (!this.trackId) {
      return;
    }

    this.flushTask = this.publishTranscription(this.currentId, this.pushedText, true);
    this.resetState();
  }

  async publishTranscription(id: string, text: string, final: boolean, signal?: AbortSignal) {
    if (!this.participantIdentity || !this.trackId) {
      return;
    }

    try {
      if (this.room.isConnected) {
        if (signal?.aborted) {
          return;
        }

        await this.room.localParticipant?.publishTranscription({
          participantIdentity: this.participantIdentity,
          trackSid: this.trackId,
          segments: [{ id, text, final, startTime: BigInt(0), endTime: BigInt(0), language: '' }],
        });
      }
    } catch (error) {
      this.logger.error(error, 'failed to publish transcription');
    }
  }
}

export class ParalellTextOutput extends TextOutput {
  /* @internal */
  _sinks: TextOutput[];

  constructor(sinks: TextOutput[]) {
    super();
    this._sinks = sinks;
  }

  async captureText(text: string) {
    await Promise.all(this._sinks.map((sink) => sink.captureText(text)));
  }

  flush() {
    for (const sink of this._sinks) {
      sink.flush();
    }
  }
}
