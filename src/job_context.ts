// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Room, LocalParticipant, RemoteParticipant } from '@livekit/rtc-node';
import { Job } from '@livekit/protocol';

export class JobContext {
  #job: Job;
  #room: Room;
  #publisher: RemoteParticipant | undefined;

  constructor(job: Job, room: Room, publisher: RemoteParticipant | undefined = undefined) {
    this.#job = job;
    this.#room = room;
    this.#publisher = publisher;
  }

  get id(): string {
    return this.#job.id;
  }

  get job(): Job {
    return this.#job;
  }

  get room(): Room {
    return this.#room;
  }

  get publisher(): RemoteParticipant | undefined {
    return this.#publisher;
  }

  get agent(): LocalParticipant | undefined {
    return this.#room.localParticipant;
  }

  // TODO(nbsp): aio
  // async shutdown() {
  //   await this.closeTx.close();
  // }
}
