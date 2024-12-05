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
import { ParticipantKind, RoomEvent, TrackKind } from '@livekit/rtc-node';
import type { Logger } from 'pino';
import { log } from './log.js';

/** Which tracks, if any, should the agent automatically subscribe to? */
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
  attributes?: { [key: string]: string };
};

export type RunningJobInfo = {
  acceptArguments: JobAcceptArguments;
  job: proto.Job;
  url: string;
  token: string;
};

/** Attempted to add a function callback, but the function already exists. */
export class FunctionExistsError extends Error {
  constructor(msg?: string) {
    super(msg);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The job and environment context as seen by the agent, accessible by the entrypoint function. */
export class JobContext {
  #proc: JobProcess;
  #info: RunningJobInfo;
  #room: Room;
  #onConnect: () => void;
  #onShutdown: (s: string) => void;
  /** @internal */
  shutdownCallbacks: (() => Promise<void>)[] = [];
  #participantEntrypoints: ((job: JobContext, p: RemoteParticipant) => Promise<void>)[] = [];
  #participantTasks: {
    [id: string]: {
      callback: (job: JobContext, p: RemoteParticipant) => Promise<void>;
      result: Promise<void>;
    };
  } = {};
  #logger: Logger;

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
    this.onParticipantConnected = this.onParticipantConnected.bind(this);
    this.#room.on(RoomEvent.ParticipantConnected, this.onParticipantConnected);
    this.#logger = log().child({ info: this.#info });
  }

  get proc(): JobProcess {
    return this.#proc;
  }

  get job(): proto.Job {
    return this.#info.job;
  }

  /** @returns The room the agent was called into */
  get room(): Room {
    return this.#room;
  }

  /** @returns The agent's participant if connected to the room, otherwise `undefined` */
  get agent(): LocalParticipant | undefined {
    return this.#room.localParticipant;
  }

  /** Adds a promise to be awaited when {@link JobContext.shutdown | shutdown} is called. */
  addShutdownCallback(callback: () => Promise<void>) {
    this.shutdownCallbacks.push(callback);
  }

  async waitForParticipant(identity?: string): Promise<RemoteParticipant> {
    if (!this.#room.isConnected) {
      throw new Error('room is not connected');
    }

    for (const p of this.#room.remoteParticipants.values()) {
      if ((!identity || p.identity === identity) && p.info.kind != ParticipantKind.AGENT) {
        return p;
      }
    }

    return new Promise((resolve, reject) => {
      const onParticipantConnected = (participant: RemoteParticipant) => {
        if (
          (!identity || participant.identity === identity) &&
          participant.info.kind != ParticipantKind.AGENT
        ) {
          clearHandlers();
          resolve(participant);
        }
      };
      const onDisconnected = () => {
        clearHandlers();
        reject(new Error('Room disconnected while waiting for participant'));
      };

      const clearHandlers = () => {
        this.#room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
        this.#room.off(RoomEvent.Disconnected, onDisconnected);
      };

      this.#room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
      this.#room.on(RoomEvent.Disconnected, onDisconnected);
    });
  }

  /**
   * Connects the agent to the room.
   *
   * @remarks
   * It is recommended to run this command as early in the function as possible, as executing it
   * later may cause noticeable delay between user and agent joins.
   *
   * @see {@link https://github.com/livekit/node-sdks/tree/main/packages/livekit-rtc#readme |
   * @livekit/rtc-node} for more information about the parameters.
   */
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

    this.#room.remoteParticipants.forEach(this.onParticipantConnected);

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

  /**
   * Gracefully shuts down the job, and runs all shutdown promises.
   *
   * @param reason - Optional reason for shutdown
   */
  shutdown(reason = '') {
    this.#onShutdown(reason);
  }

  /** @internal */
  onParticipantConnected(p: RemoteParticipant) {
    for (const callback of this.#participantEntrypoints) {
      if (this.#participantTasks[p.identity]?.callback == callback) {
        this.#logger.warn(
          'a participant has joined before a prior prticipant task matching the same identity has finished:',
          p.identity,
        );
      }
      const result = callback(this, p);
      result.finally(() => delete this.#participantTasks[p.identity]);
      this.#participantTasks[p.identity] = { callback, result };
    }
  }

  /**
   * Adds a promise to be awaited whenever a new participant joins the room.
   *
   * @throws {@link FunctionExistsError} if an entrypoint already exists
   */
  addParticipantEntrypoint(callback: (job: JobContext, p: RemoteParticipant) => Promise<void>) {
    if (this.#participantEntrypoints.includes(callback)) {
      throw new FunctionExistsError('entrypoints cannot be added more than once');
    }

    this.#participantEntrypoints.push(callback);
  }
}

export class JobProcess {
  #pid = process.pid;
  userData: { [id: string]: unknown } = {};

  get pid(): number {
    return this.#pid;
  }
}

/**
 * A request sent by the server to spawn a new agent job.
 *
 * @remarks
 * For most applications, this is best left to the default, which simply accepts the job and
 * handles the logic inside the entrypoint function. This class is useful for vetting which
 * requests should fill idle processes and which should be outright rejected.
 */
export class JobRequest {
  #job: proto.Job;
  #onReject: () => Promise<void>;
  #onAccept: (args: JobAcceptArguments) => Promise<void>;

  /** @internal */
  constructor(
    job: proto.Job,
    onReject: () => Promise<void>,
    onAccept: (args: JobAcceptArguments) => Promise<void>,
  ) {
    this.#job = job;
    this.#onReject = onReject;
    this.#onAccept = onAccept;
  }

  /** @returns The ID of the job, set by the LiveKit server */
  get id(): string {
    return this.#job.id;
  }

  /** @see {@link https://www.npmjs.com/package/@livekit/protocol | @livekit/protocol} */
  get job(): proto.Job {
    return this.#job;
  }

  /** @see {@link https://www.npmjs.com/package/@livekit/protocol | @livekit/protocol} */
  get room(): proto.Room | undefined {
    return this.#job.room;
  }

  /** @see {@link https://www.npmjs.com/package/@livekit/protocol | @livekit/protocol} */
  get publisher(): proto.ParticipantInfo | undefined {
    return this.#job.participant;
  }

  /** @returns The agent's name, as set in {@link WorkerOptions} */
  get agentName(): string {
    return this.#job.agentName;
  }

  /** Rejects the job. */
  async reject() {
    await this.#onReject();
  }

  /** Accepts the job, launching it on an idle child process. */
  async accept(name = '', identity = '', metadata = '', attributes?: { [key: string]: string }) {
    if (identity === '') identity = 'agent-' + this.id;

    this.#onAccept({ name, identity, metadata, attributes });
  }
}
