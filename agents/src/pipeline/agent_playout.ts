import { AudioFrame, AudioSource } from '@livekit/rtc-node';
import { log } from '../log.js';
import { TranscriptionForwarder } from '../transcription.js';
import { AsyncIterableQueue, CancellablePromise, Future, gracefullyCancel } from '../utils.js';

export enum AgentPlayoutEventType {
  PLAYOUT_STARTED,
  PLAYOUT_STOPPED,
}

export interface AgentPlayoutEvent {
  type: AgentPlayoutEventType;
  interrupted?: boolean;
}

export class PlayoutHandle {
  #speechId: string;
  #audioSource: AudioSource;
  playoutSource: AsyncIterable<AudioFrame>;
  transcriptionForwarder: TranscriptionForwarder;
  totalPlayedTime?: number;
  #interrupted = false;
  pushedDuration = 0;
  intFut = new Future();
  doneFut = new Future();

  constructor(
    speechId: string,
    audioSource: AudioSource,
    playoutSource: AsyncIterable<AudioFrame>,
    transcriptionForwarder: TranscriptionForwarder,
  ) {
    this.#speechId = speechId;
    this.#audioSource = audioSource;
    this.playoutSource = playoutSource;
    this.transcriptionForwarder = transcriptionForwarder;
  }

  get speechId(): string {
    return this.#speechId;
  }

  get interrupted(): boolean {
    return this.#interrupted;
  }

  get timePlayed(): number {
    return this.totalPlayedTime || this.pushedDuration - this.#audioSource.queuedDuration;
  }

  get done(): boolean {
    return this.doneFut.done || this.#interrupted;
  }

  interrupt() {
    if (this.done) {
      return;
    }

    this.intFut.resolve();
    this.#interrupted = true;
  }

  join(): Future {
    return this.doneFut;
  }
}

export class AgentPlayout implements AsyncIterableIterator<AgentPlayoutEvent> {
  #queue = new AsyncIterableQueue<AgentPlayoutEvent>();
  #closed = false;

  #audioSource: AudioSource;
  #targetVolume = 1;
  #playoutTask?: CancellablePromise<void>;
  #logger = log();

  constructor(audioSource: AudioSource) {
    this.#audioSource = audioSource;
  }

  get targetVolume(): number {
    return this.#targetVolume;
  }

  set targetVolume(vol: number) {
    this.#targetVolume = vol;
  }

  play(
    speechId: string,
    playoutSource: AsyncIterable<AudioFrame>,
    transcriptionForwarder: TranscriptionForwarder,
  ) {
    if (this.#closed) {
      throw new Error('source closed');
    }

    const handle = new PlayoutHandle(
      speechId,
      this.#audioSource,
      playoutSource,
      transcriptionForwarder,
    );

    this.#playoutTask = CancellablePromise.from(this.#playout(handle, this.#playoutTask));
  }

  async #playout(handle: PlayoutHandle, oldTask?: CancellablePromise<void>) {
    if (oldTask) {
      await gracefullyCancel(oldTask);
    }

    if (this.#audioSource.queuedDuration > 0) {
      // this should not happen, but log it just in case
      this.#logger
        .child({ speechId: handle.speechId, queuedDuration: this.#audioSource.queuedDuration })
        .warn('new playout while the source is still playing');
    }

    let firstFrame = true;

    const captureTask = new CancellablePromise<void>(async (resolve, reject, onCancel) => {
      let cancelled = false;
      onCancel(() => {
        cancelled = true;
      });

      for await (const frame of handle.playoutSource) {
        if (cancelled) break;
        if (firstFrame) {
          // handle.transcriptionForwarder.segmentPlayoutStarted()
          this.#logger.child({ speechId: handle.speechId }).debug('started playing the first time');
          this.#queue.put({ type: AgentPlayoutEventType.PLAYOUT_STARTED });
          firstFrame = false;
        }
        handle.pushedDuration += frame.samplesPerChannel / frame.sampleRate;
        await this.#audioSource.captureFrame(frame);
      }

      if (this.#audioSource.queuedDuration > 0) {
        await this.#audioSource.waitForPlayout();
      }

      if (cancelled) {
        reject();
      } else {
        resolve();
      }
    });

    try {
      await Promise.any([captureTask, handle.intFut]);
    } finally {
      await gracefullyCancel(captureTask);
      handle.totalPlayedTime = handle.pushedDuration - this.#audioSource.queuedDuration;

      if (handle.interrupted || captureTask.error) {
        this.#audioSource.clearQueue(); // make sure to remove any queued frames
      }

      if (!firstFrame) {
        if (!handle.interrupted) {
          // handle.transcriptionForwarder.segmentPlayoutFinished()
        }
        this.#queue.put({
          type: AgentPlayoutEventType.PLAYOUT_STOPPED,
          interrupted: handle.interrupted,
        });
      }

      await handle.transcriptionForwarder.close(handle.interrupted);
      handle.doneFut.resolve();

      this.#logger
        .child({ speechId: handle.speechId, interrupted: handle.interrupted })
        .debug('playout finished');
    }
  }

  next(): Promise<IteratorResult<AgentPlayoutEvent>> {
    return this.#queue.next();
  }

  async close() {
    this.#closed = true;
    await this.#playoutTask;
    this.#queue.close();
  }

  [Symbol.asyncIterator](): AgentPlayout {
    return this;
  }
}
