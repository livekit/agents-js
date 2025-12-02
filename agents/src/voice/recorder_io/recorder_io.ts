import { Mutex } from '@livekit/mutex';
import type { AudioFrame } from '@livekit/rtc-node';
import { type StreamChannel, createStreamChannel } from 'agents/src/stream/stream_channel.js';
import { Future, Task } from 'agents/src/utils.js';
import type { AgentSession } from '../agent_session.js';
import { AudioInput, AudioOutput } from '../io.js';

const WRITE_INTERNAL_MS = 2500;
const DEFAULT_SAMPLE_RATE = 48000;

export interface RecorderOptions {
  agentSession: AgentSession;
  sampleRate?: number;
}

export class RecorderIO {
  private inRecord?: RecorderAudioInput;
  private outRecord?: RecorderAudioOutput;

  private inChan: StreamChannel<AudioFrame[]> = createStreamChannel<AudioFrame[]>();
  private outChan: StreamChannel<AudioFrame[]> = createStreamChannel<AudioFrame[]>();

  private session: AgentSession;
  private sampleRate: number;

  private _outputPath?: string;
  private forwardTask?: Task<void>;

  private closeFuture: Future<void> = new Future();
  private lock: Mutex = new Mutex();
  private started: boolean = false;

  constructor(opts: RecorderOptions) {
    const { agentSession, sampleRate = DEFAULT_SAMPLE_RATE } = opts;

    this.session = agentSession;
    this.sampleRate = sampleRate;
  }

  async start(outputPath: string): Promise<void> {
    const unlock = await this.lock.lock();

    try {
      if (this.started) return;

      if (!this.inRecord || !this.outRecord) {
        throw new Error(
          'RecorderIO not properly initialized: both `recordInput()` and `recordOutput()` must be called before starting the recorder.',
        );
      }

      this._outputPath = outputPath;
      this.started = true;
      this.closeFuture = new Future();

      this.forwardTask = Task.from(({ signal }) => this.forward(signal));
    } finally {
      unlock();
    }
  }

  async close(): Promise<void> {}

  recordInput(audioInput: AudioInput): RecorderAudioInput {
    throw new Error('Not implemented');
  }

  recordOutput(audioOutput: AudioOutput): RecorderAudioOutput {
    throw new Error('Not implemented');
  }

  get recording(): boolean {
    return this.started;
  }

  get outputPath(): string | undefined {
    return this._outputPath;
  }

  get recordingStartedAt(): number | undefined {
    throw new Error('Not implemented');
  }

  private async forward(signal: AbortSignal): Promise<void> {}
}

class RecorderAudioInput extends AudioInput {}

class RecorderAudioOutput extends AudioOutput {
  clearBuffer(): void {}
}
