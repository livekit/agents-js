// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession as pb } from '@livekit/protocol';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import { log } from '../log.js';
import { createStreamChannel } from '../stream/stream_channel.js';
import { Future, Task } from '../utils.js';
import type { AgentSession } from './agent_session.js';
import { AudioInput, AudioOutput } from './io.js';
import type { SessionTransport } from './remote_session.js';

// The Go CLI / browser broker speaks 48 kHz on the wire; the agent pipeline
// runs at 24 kHz. Resample on the way in and out.
const WIRE_SAMPLE_RATE = 48000;
const AGENT_SAMPLE_RATE = 24000;

function consoleFrameToRtc(frame: pb.AgentSessionMessage_ConsoleIO_AudioFrame): AudioFrame {
  // Copy into a fresh, 2-byte-aligned buffer; the protobuf bytes may start at an
  // odd offset, which would make an Int16Array view throw.
  const aligned = new ArrayBuffer(frame.data.byteLength);
  new Uint8Array(aligned).set(frame.data);
  return new AudioFrame(
    new Int16Array(aligned),
    frame.sampleRate,
    frame.numChannels,
    frame.samplesPerChannel,
  );
}

function rtcFrameToConsole(frame: AudioFrame): pb.AgentSessionMessage_ConsoleIO_AudioFrame {
  return new pb.AgentSessionMessage_ConsoleIO_AudioFrame({
    data: new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
    sampleRate: frame.sampleRate,
    numChannels: frame.channels,
    samplesPerChannel: frame.samplesPerChannel,
  });
}

/**
 * Audio input fed by inbound `audio_input` console messages. Frames arrive at
 * the wire rate, are resampled to the agent rate, and pushed into the base
 * {@link AudioInput} stream that the STT pipeline reads from.
 *
 * Unlike the python port, no cross-thread queue is needed: the JS console job
 * runs in-process on a single event loop, so a stream channel is sufficient.
 *
 * @experimental
 */
export class TcpAudioInput extends AudioInput {
  private readonly channel = createStreamChannel<AudioFrame>();
  private readonly resampler = new AudioResampler(WIRE_SAMPLE_RATE, AGENT_SAMPLE_RATE, 1);
  private closed = false;

  constructor() {
    super();
    this.multiStream.addInputStream(this.channel.stream());
  }

  pushFrame(frame: pb.AgentSessionMessage_ConsoleIO_AudioFrame): void {
    if (this.closed) return;
    for (const resampled of this.resampler.push(consoleFrameToRtc(frame))) {
      void this.channel.write(resampled);
    }
  }

  override async close(): Promise<void> {
    this.closed = true;
    await this.channel.close();
    await super.close();
  }
}

/**
 * Audio output that streams the agent's TTS frames to the broker as
 * `audio_output` console messages (resampled to the wire rate) and drives the
 * flush/clear playout handshake. A flush blocks the agent turn until the broker
 * reports `audio_playback_finished` (or the buffer is cleared on interruption).
 *
 * @experimental
 */
export class TcpAudioOutput extends AudioOutput {
  private readonly transport: SessionTransport;
  private readonly resampler = new AudioResampler(AGENT_SAMPLE_RATE, WIRE_SAMPLE_RATE, 1);

  private pushedDurationMs = 0;
  private captureStartedAt = 0;
  private flushTask?: Task<void>;
  private playoutDone = new Future();
  private interrupted = new Future();

  constructor(transport: SessionTransport) {
    super(AGENT_SAMPLE_RATE, undefined, { pause: true });
    this.transport = transport;
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    await super.captureFrame(frame);

    if (this.flushTask && !this.flushTask.done) {
      log().error('captureFrame called while previous flush is in progress');
      await this.flushTask.result;
    }

    if (this.pushedDurationMs === 0) {
      this.captureStartedAt = Date.now();
      this.onPlaybackStarted(Date.now());
    }

    this.pushedDurationMs += (frame.samplesPerChannel / frame.sampleRate) * 1000;

    for (const resampled of this.resampler.push(frame)) {
      await this.transport.sendMessage(
        new pb.AgentSessionMessage({
          message: { case: 'audioOutput', value: rtcFrameToConsole(resampled) },
        }),
      );
    }
  }

  override flush(): void {
    super.flush();
    void this.transport.sendMessage(
      new pb.AgentSessionMessage({
        message: {
          case: 'audioPlaybackFlush',
          value: new pb.AgentSessionMessage_ConsoleIO_AudioPlaybackFlush(),
        },
      }),
    );

    if (this.pushedDurationMs > 0) {
      if (this.flushTask && !this.flushTask.done) {
        log().error('flush called while previous flush is in progress');
        this.flushTask.cancel();
      }
      this.playoutDone = new Future();
      this.interrupted = new Future();
      this.flushTask = Task.from(() => this.runPlayoutHandshake());
    }
  }

  override clearBuffer(): void {
    void this.transport.sendMessage(
      new pb.AgentSessionMessage({
        message: {
          case: 'audioPlaybackClear',
          value: new pb.AgentSessionMessage_ConsoleIO_AudioPlaybackClear(),
        },
      }),
    );

    if (this.pushedDurationMs > 0) {
      this.interrupted.resolve();
    }
  }

  /** Called by {@link SessionHost} when the broker reports playout finished. */
  notifyPlayoutFinished(): void {
    if (!this.playoutDone.done) {
      this.playoutDone.resolve();
    }
  }

  private async runPlayoutHandshake(): Promise<void> {
    try {
      await Promise.race([this.playoutDone.await, this.interrupted.await]);
    } catch {
      return; // cancelled by a subsequent flush
    }
    const interrupted = this.interrupted.done && !this.playoutDone.done;

    let playedMs: number;
    if (interrupted) {
      const elapsed = Date.now() - this.captureStartedAt;
      playedMs = Math.min(Math.max(0, elapsed), this.pushedDurationMs);
    } else {
      playedMs = this.pushedDurationMs;
    }

    this.onPlaybackFinished({ playbackPosition: playedMs / 1000, interrupted });

    this.pushedDurationMs = 0;
    this.interrupted = new Future();
  }
}

/**
 * Process-wide singleton that carries the console transport (and audio IO) from
 * the `console` CLI runner into the {@link AgentSession} that starts inside the
 * agent entrypoint. Mirrors python `AgentsConsole`.
 *
 * The runner sets {@link enabled} and the transport; `AgentSession._startImpl`
 * then calls {@link acquireIo} to wire the session and build its `SessionHost`.
 *
 * @experimental
 */
export class AgentsConsole {
  private static _instance?: AgentsConsole;

  static getInstance(): AgentsConsole {
    if (!AgentsConsole._instance) {
      AgentsConsole._instance = new AgentsConsole();
    }
    return AgentsConsole._instance;
  }

  /** @internal — reset the process-wide singleton (test only). */
  static _reset(): void {
    AgentsConsole._instance = undefined;
  }

  enabled = false;
  record = false;
  transport?: SessionTransport;
  audioInput?: TcpAudioInput;
  audioOutput?: TcpAudioOutput;

  private acquired = false;

  get ioAcquired(): boolean {
    return this.acquired;
  }

  /** Wire the session's IO for console mode. */
  acquireIo(session: AgentSession): void {
    if (this.acquired) {
      throw new Error('the console IO was already acquired by another session');
    }
    this.acquired = true;

    // Attach the audio bridges, enabled by default (voice mode). A text-mode
    // driver disables them at runtime with an `update_io` request (audio off),
    // so one wiring path serves both modes.
    session.input.audio = this.audioInput ?? null;
    session.output.audio = this.audioOutput ?? null;
    session.output.transcription = null;
  }
}
