import { JobContext } from './job_context';
import { VideoGrant } from 'livekit-server-sdk';
import { Job, ParticipantInfo, Room } from '@livekit/protocol';
import { log } from './log';
import { EventEmitter } from 'events';

class AnsweredError extends Error {
  constructor() {
    super();
    this.name = 'AnsweredError';
    this.message = 'request already answered';
  }
}

enum AutoDisconnect {
  ROOM_EMPTY,
  PUBLISHER_LEFT,
  NONE,
}

enum AutoSubscribe {
  SUBSCRIBE_ALL,
  SUBSCRIBE_NONE,
  VIDEO_ONLY,
  AUDIO_ONLY,
}

type AgentEntry = (ctx: JobContext) => Promise<void>;

type AcceptData = {
  entry: AgentEntry;
  autoSubscribe: AutoSubscribe;
  autoDisconnect: AutoDisconnect;
  grants: VideoGrant;
  name: string;
  identity: string;
  metadata: string;
  assign: EventEmitter;
};

type AvailRes = {
  avail: boolean;
  data: AcceptData | undefined;
};

export class JobRequest {
  #job: Job;
  #answered = false;
  tx: EventEmitter;
  logger = log.child({ job: this.job });

  constructor(job: Job, tx: EventEmitter) {
    this.#job = job;
    this.tx = tx;
  }

  get id(): string {
    return this.#job.id;
  }

  get job(): Job {
    return this.#job;
  }

  get room(): Room | undefined {
    return this.#job.room;
  }

  get publisher(): ParticipantInfo | undefined {
    return this.#job.participant;
  }

  get answered(): boolean {
    return this.#answered;
  }

  async reject() {
    if (this.#answered) {
      throw new AnsweredError();
    }
    this.#answered = true;
    this.tx.emit('recv', { avail: false, data: undefined } as AvailRes);
    this.logger.info('rejected job', this.id);
  }

  async accept(
    entry: AgentEntry,
    autoSubscribe: AutoSubscribe = AutoSubscribe.SUBSCRIBE_ALL,
    autoDisconnect: AutoDisconnect = AutoDisconnect.ROOM_EMPTY,
    grants: VideoGrant,
    name: string = '',
    identity: string = '',
    metadata: string = '',
  ) {
    if (this.#answered) {
      throw new AnsweredError();
    }
    this.#answered = true;

    const assign = new EventEmitter();
    assign.on('error', (e) => {
      throw e;
    });

    const data: AcceptData = {
      entry,
      autoSubscribe,
      autoDisconnect,
      grants,
      name,
      identity,
      metadata,
      assign,
    };

    this.tx.emit('recv', { avail: true, data } as AvailRes);

    this.logger.info('accepted job', this.id);
  }
}
