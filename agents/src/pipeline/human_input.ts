// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AudioStream,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  TrackSource,
  Transcription,
} from '@livekit/rtc-node';
import { log } from '../log.js';
import { STT, SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { BasicTranscriptionForwarder, TranscriptionForwarder } from '../transcription.js';
import { AsyncIterableQueue, CancellablePromise, gracefullyCancel } from '../utils.js';
import { VAD, VADEvent, VADEventType } from '../vad.js';

export enum HumanInputEventType {
  START_OF_SPEECH,
  VAD_INFERENCE_DONE,
  END_OF_SPEECH,
  FINAL_TRANSCRIPT,
  INTERIM_TRANSCRIPT,
}

export type HumanInputEvent =
  | {
      type:
        | HumanInputEventType.START_OF_SPEECH
        | HumanInputEventType.VAD_INFERENCE_DONE
        | HumanInputEventType.END_OF_SPEECH;
      event: VADEvent;
    }
  | {
      type: HumanInputEventType.FINAL_TRANSCRIPT | HumanInputEventType.INTERIM_TRANSCRIPT;
      event: SpeechEvent;
    };

export class HumanInput implements AsyncIterableIterator<HumanInputEvent> {
  #queue = new AsyncIterableQueue<HumanInputEvent>();
  #closed = false;

  #room: Room;
  #vad: VAD;
  #stt: STT;
  #participant: RemoteParticipant;
  #transciption: boolean;
  #subscribedTrack?: RemoteAudioTrack;
  #recognizeTask?: CancellablePromise<void>;
  #speaking = false;
  #speechProbability = 0;
  #logger = log();

  constructor(
    room: Room,
    vad: VAD,
    stt: STT,
    participant: RemoteParticipant,
    transcription: boolean,
  ) {
    this.#room = room;
    this.#vad = vad;
    this.#stt = stt;
    this.#participant = participant;
    this.#transciption = transcription;

    this.#room.on(RoomEvent.TrackPublished, this.#subscribeToMicrophone);
    this.#room.on(RoomEvent.TrackSubscribed, this.#subscribeToMicrophone);
    this.#subscribeToMicrophone();
  }

  #subscribeToMicrophone(): void {
    if (!this.#participant) {
      this.#logger.error('Participant is not set');
      return;
    }

    let microphonePublication: RemoteTrackPublication | undefined = undefined;
    for (const publication of this.#participant.trackPublications.values()) {
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

    const track = microphonePublication.track;
    if (track && track !== this.#subscribedTrack) {
      this.#subscribedTrack = track;
      if (this.#recognizeTask) {
        this.#recognizeTask.cancel();
      }

      const audioStream = new AudioStream(track, 16000);

      this.#recognizeTask = new CancellablePromise(async (resolve, reject, onCancel) => {
        let cancelled = false;
        onCancel(() => {
          cancelled = true;
        });

        const sttStream = this.#stt.stream();
        const vadStream = this.#vad.stream();

        // TODO(nbsp): STTSegmentsForwarder update
        // const beforeForward = (forwarder: TranscriptionForwarder, transcription: Transcription) => {
        //   if (!this.#transciption) {
        //     transcription.segments = []
        //   }
        // }

        const forwarder = new BasicTranscriptionForwarder(
          this.#room,
          this.#participant.identity,
          this.#subscribedTrack!.sid,
          'SG_000000000000',
        );

        const audioStreamCo = async () => {
          for await (const ev of audioStream) {
            if (cancelled) return;
            sttStream.pushFrame(ev);
            vadStream.pushFrame(ev);
          }
        };

        const vadStreamCo = async () => {
          for await (const ev of vadStream) {
            if (cancelled) return;
            switch (ev.type) {
              case VADEventType.START_OF_SPEECH:
                this.#speaking = true;
                this.#queue.put({ type: HumanInputEventType.START_OF_SPEECH, event: ev });
                break;
              case VADEventType.INFERENCE_DONE:
                this.#speechProbability = ev.probability;
                this.#queue.put({ type: HumanInputEventType.VAD_INFERENCE_DONE, event: ev });
                break;
              case VADEventType.END_OF_SPEECH:
                this.#speaking = false;
                this.#queue.put({ type: HumanInputEventType.END_OF_SPEECH, event: ev });
                break;
            }
          }
        };

        const sttStreamCo = async () => {
          for await (const ev of sttStream) {
            if (cancelled) return;
            if (ev.type === SpeechEventType.FINAL_TRANSCRIPT) {
              forwarder.pushText(ev.alternatives[0].text);
              this.#queue.put({ type: HumanInputEventType.FINAL_TRANSCRIPT, event: ev });
            } else {
              this.#queue.put({ type: HumanInputEventType.INTERIM_TRANSCRIPT, event: ev });
            }
          }
        };

        await Promise.all([audioStreamCo(), vadStreamCo(), sttStreamCo()]);
        await forwarder.close(false);
        sttStream.close();
        vadStream.close();
        if (cancelled) {
          resolve();
        } else {
          reject();
        }
      });
    }
  }

  get speaking(): boolean {
    return this.#speaking;
  }

  get speakingProbability(): number {
    return this.#speechProbability;
  }

  next(): Promise<IteratorResult<HumanInputEvent>> {
    return this.#queue.next();
  }

  async close() {
    if (this.#closed) {
      throw new Error('HumanInput already closed');
    }
    this.#closed = true;
    this.#room.removeAllListeners();
    this.#speaking = false;
    if (this.#recognizeTask) {
      await gracefullyCancel(this.#recognizeTask);
    }
    this.#queue.close();
  }

  [Symbol.asyncIterator](): HumanInput {
    return this;
  }
}
