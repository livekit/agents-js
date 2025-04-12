// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  NoiseCancellationOptions,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
} from '@livekit/rtc-node';
import { AudioStream, RoomEvent, TrackSource } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import type { STT, SpeechEvent } from '../stt/stt.js';
import { SpeechEventType } from '../stt/stt.js';
import { CancellablePromise, gracefullyCancel } from '../utils.js';
import type { VAD, VADEvent } from '../vad.js';
import { VADEventType } from '../vad.js';

export enum HumanInputEvent {
  START_OF_SPEECH,
  VAD_INFERENCE_DONE,
  END_OF_SPEECH,
  FINAL_TRANSCRIPT,
  INTERIM_TRANSCRIPT,
}

export type HumanInputCallbacks = {
  [HumanInputEvent.START_OF_SPEECH]: (event: VADEvent) => void;
  [HumanInputEvent.VAD_INFERENCE_DONE]: (event: VADEvent) => void;
  [HumanInputEvent.END_OF_SPEECH]: (event: VADEvent) => void;
  [HumanInputEvent.FINAL_TRANSCRIPT]: (event: SpeechEvent) => void;
  [HumanInputEvent.INTERIM_TRANSCRIPT]: (event: SpeechEvent) => void;
};

export class HumanInput extends (EventEmitter as new () => TypedEmitter<HumanInputCallbacks>) {
  #closed = false;
  #room: Room;
  #vad: VAD;
  #stt: STT;
  #participant: RemoteParticipant;
  #subscribedTrack?: RemoteAudioTrack;
  #recognizeTask?: CancellablePromise<void>;
  #speaking = false;
  #speechProbability = 0;
  #logger = log();
  #noiseCancellation?: NoiseCancellationOptions;

  constructor(
    room: Room,
    vad: VAD,
    stt: STT,
    participant: RemoteParticipant,
    noiseCancellation?: NoiseCancellationOptions,
  ) {
    super();
    this.#room = room;
    this.#vad = vad;
    this.#stt = stt;
    this.#participant = participant;
    this.#noiseCancellation = noiseCancellation;

    this.#room.on(RoomEvent.TrackPublished, this.#subscribeToMicrophone.bind(this));
    this.#room.on(RoomEvent.TrackSubscribed, this.#subscribeToMicrophone.bind(this));
    this.#subscribeToMicrophone();
  }

  get participant(): RemoteParticipant {
    return this.#participant;
  }

  get subscribedTrack(): RemoteAudioTrack | undefined {
    return this.#subscribedTrack;
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

      const audioStreamOptions = {
        sampleRate: 16000,
        numChannels: 1,
        ...(this.#noiseCancellation ? { noiseCancellation: this.#noiseCancellation } : {}),
      };
      const audioStream = new AudioStream(track, audioStreamOptions);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      this.#recognizeTask = new CancellablePromise(async (resolve, _, onCancel) => {
        let cancelled = false;
        onCancel(() => {
          cancelled = true;
        });

        const sttStream = this.#stt.stream();
        const vadStream = this.#vad.stream();

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
                this.emit(HumanInputEvent.START_OF_SPEECH, ev);
                break;
              case VADEventType.INFERENCE_DONE:
                this.#speechProbability = ev.probability;
                this.emit(HumanInputEvent.VAD_INFERENCE_DONE, ev);
                break;
              case VADEventType.END_OF_SPEECH:
                this.#speaking = false;
                this.emit(HumanInputEvent.END_OF_SPEECH, ev);
                break;
            }
          }
        };

        const sttStreamCo = async () => {
          for await (const ev of sttStream) {
            if (cancelled) return;
            if (ev.type === SpeechEventType.FINAL_TRANSCRIPT) {
              this.emit(HumanInputEvent.FINAL_TRANSCRIPT, ev);
            } else if (ev.type == SpeechEventType.INTERIM_TRANSCRIPT) {
              this.emit(HumanInputEvent.INTERIM_TRANSCRIPT, ev);
            }
          }
        };

        await Promise.all([audioStreamCo(), vadStreamCo(), sttStreamCo()]);
        sttStream.close();
        vadStream.close();
        resolve();
      });
    }
  }

  get speaking(): boolean {
    return this.#speaking;
  }

  get speakingProbability(): number {
    return this.#speechProbability;
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
  }
}
