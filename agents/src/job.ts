// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as proto from '@livekit/protocol';
import type {
  E2EEOptions,
  LocalParticipant,
  RemoteParticipant,
  Room,
  RtcConfiguration,
} from '@livekit/rtc-node';
import { RoomEvent, TrackKind } from '@livekit/rtc-node';
import { log } from './log.js';

export enum AutoSubscribe {
  SUBSCRIBE_ALL,
  SUBSCRIBE_NONE,
  VIDEO_ONLY,
  AUDIO_ONLY,
}

export type JobAcceptArguments = {
  name: string;
  identity: string;
  metadata: string;
};

export type RunningJobInfo = {
  acceptArguments: JobAcceptArguments;
  job: proto.Job;
  url: string;
  token: string;
};

export class JobContext {
  #proc: JobProcess;
  #info: RunningJobInfo;
  #room: Room;
  #onConnect: () => void;
  #onShutdown: (s: string) => void;
  #shutdownCallbacks: (() => Promise<void>)[] = [];
  #participantEntrypoints: ((job: JobContext, p: RemoteParticipant) => Promise<void>)[] = [];
  #participantTasks: {
    [id: string]: {
      callback: (job: JobContext, p: RemoteParticipant) => Promise<void>;
      result: Promise<void>;
    };
  } = {};

  constructor(
    proc: JobProcess,
    info: RunningJobInfo,
    room: Room,
    onConnect: () => void,
    onShutdown: (s: string) => void,
  ) {
    this.#proc = proc;
    this.#info = info;
    this.#room = room;
    this.#onConnect = onConnect;
    this.#onShutdown = onShutdown;
    this.#room.on(RoomEvent.ParticipantConnected, this.#onParticipantConnected);
  }

  get proc(): JobProcess {
    return this.#proc;
  }

  get job(): proto.Job {
    return this.#info.job;
  }

  get room(): Room {
    return this.#room;
  }

  get agent(): LocalParticipant | undefined {
    return this.#room.localParticipant;
  }

  addShutdownCallback(callback: () => Promise<void>) {
    this.#shutdownCallbacks.push(callback);
  }

  async connect(
    e2ee?: E2EEOptions,
    autoSubscribe: AutoSubscribe = AutoSubscribe.SUBSCRIBE_ALL,
    rtcConfig?: RtcConfiguration,
  ) {
    const opts = {
      e2ee,
      autoSubscribe: autoSubscribe == AutoSubscribe.SUBSCRIBE_ALL,
      rtcConfig,
      dynacast: false,
    };

    await this.#room.connect(this.#info.url, this.#info.token, opts);
    this.#onConnect();

    this.#room.remoteParticipants.forEach(this.#onParticipantConnected);

    if ([AutoSubscribe.AUDIO_ONLY, AutoSubscribe.VIDEO_ONLY].includes(autoSubscribe)) {
      this.#room.remoteParticipants.forEach((p) => {
        p.trackPublications.forEach((pub) => {
          if (
            (autoSubscribe === AutoSubscribe.AUDIO_ONLY && pub.kind === TrackKind.KIND_AUDIO) ||
            (autoSubscribe === AutoSubscribe.VIDEO_ONLY && pub.kind === TrackKind.KIND_VIDEO)
          ) {
            pub.setSubscribed(true);
          }
        });
      });
    }
  }

  shutdown(reason = '') {
    this.#onShutdown(reason);
  }

  #onParticipantConnected(p: RemoteParticipant) {
    for (const callback of this.#participantEntrypoints) {
      if (
        p.identity in this.#participantTasks &&
        this.#participantTasks[p.identity].callback == callback
      ) {
        log.warn(
          'a participant has joined before a prior prticipant task matching the same identity has finished:',
          p.identity,
        );
      }
      const result = callback(this, p);
      result.finally(() => delete this.#participantTasks[p.identity]);
      this.#participantTasks[p.identity] = { callback, result };
    }
  }

  addParticipantEntrypoint(callback: (job: JobContext, p: RemoteParticipant) => Promise<void>) {
    if (this.#participantEntrypoints.includes(callback)) {
      throw new Error('entrypoints cannot be added more than once');
    }

    this.#participantEntrypoints.push(callback);
  }
}

export class JobProcess {
  #pid = process.pid;
  #userData: { [id: string]: unknown } = {};
  #startArguments: unknown;

  constructor(startArguments?: unknown) {
    this.#startArguments = startArguments;
  }

  get pid(): number {
    return this.#pid;
  }

  get userData(): { [id: string]: unknown } {
    return this.#userData;
  }

  get startArguments(): unknown {
    return this.#startArguments;
  }
}

export class JobRequest {
  #job: proto.Job;
  #onReject: () => Promise<void>;
  #onAccept: (args: JobAcceptArguments) => Promise<void>;

  constructor(
    job: proto.Job,
    onReject: () => Promise<void>,
    onAccept: (args: JobAcceptArguments) => Promise<void>,
  ) {
    this.#job = job;
    this.#onReject = onReject;
    this.#onAccept = onAccept;
  }

  get id(): string {
    return this.#job.id;
  }

  get job(): proto.Job {
    return this.#job;
  }

  get room(): proto.Room | undefined {
    return this.#job.room;
  }

  get publisher(): proto.ParticipantInfo | undefined {
    return this.#job.participant;
  }

  get agentName(): string {
    return this.#job.agentName;
  }

  async reject() {
    await this.#onReject();
  }

  async accept(name = '', identity = '', metadata = '') {
    if (identity === '') identity = 'agent-' + this.id;

    this.#onAccept({ name, identity, metadata });
  }
}
