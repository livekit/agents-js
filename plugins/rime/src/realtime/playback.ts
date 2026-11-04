// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { voice } from '@livekit/agents';
import { type AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type * as r from '@rimelabs/sdk';

const KEY = 'rime.prism.output';
export type PlaybackMode = 'auto' | 'estimated' | 'discard';
export interface OutputToken {
  owner: Playback;
  responseId: string;
  generated: number;
  accepted: number;
  played: number;
  invalid: boolean;
}
interface FrameIdentity {
  token: OutputToken;
  offset: number;
  samples: number;
}
interface Response {
  ref: r.ResponseRef;
  outputs: OutputToken[];
  ended: boolean;
  interrupted: boolean;
  reporting: boolean;
  hold: r.ResponseHold;
  deadline?: NodeJS.Timeout;
}

/** Owns playback evidence and SDK references until reporting or bounded expiry. */
export class Playback {
  private responses = new Map<string, Response>();
  private finalized = new Set<string>();
  private queue: r.PlaybackReport[] = [];
  private worker?: Promise<void>;
  closed = false;
  constructor(
    private sdk: r.RealtimeSession,
    private mode: PlaybackMode,
    private timeout: number,
    private measured: () => boolean,
    private report: (report: r.PlaybackReport) => Promise<void>,
    private spawn: (work: Promise<void>) => void,
  ) {}

  start(ref: r.ResponseRef): void {
    if (this.mode === 'estimated' || (this.mode === 'auto' && !this.measured())) return;
    if (this.responses.size >= 128) {
      const old = [...this.responses.values()].find((r) => r.ended && !r.reporting);
      if (!old) return;
      this.release(old.ref.responseId);
    }
    this.responses.set(ref.responseId, {
      ref,
      outputs: [],
      ended: false,
      interrupted: false,
      reporting: false,
      hold: this.sdk.holdResponse(ref),
    });
  }
  output(ref: r.OutputRef): OutputToken | undefined {
    const state = this.responses.get(ref.response.responseId);
    if (!state) return;
    const token: OutputToken = {
      owner: this,
      responseId: ref.response.responseId,
      generated: 0,
      accepted: 0,
      played: 0,
      invalid: false,
    };
    state.outputs.push(token);
    return token;
  }
  tag(token: OutputToken | undefined, frame: AudioFrame): void {
    if (!token) return;
    frame.userdata[KEY] = {
      token,
      offset: token.generated,
      samples: frame.samplesPerChannel,
    } satisfies FrameIdentity;
    token.generated += frame.samplesPerChannel;
  }
  end(ref: r.ResponseRef, interrupted = false): void {
    const state = this.responses.get(ref.responseId);
    if (!state || state.ended) return;
    state.ended = true;
    state.interrupted ||= interrupted;
    state.deadline = setTimeout(
      () => {
        if (!state.reporting) this.release(ref.responseId);
      },
      state.outputs.reduce((n, o) => n + o.generated / 24, 0) + this.timeout,
    );
    state.deadline.unref();
    this.check(state);
  }
  interrupt(report: r.PlaybackInterrupted): void {
    const id = report.output.response.responseId;
    if (this.closed || this.finalized.has(id)) return;
    const state = this.responses.get(id);
    if (state) {
      state.interrupted = true;
      state.reporting = true;
    }
    this.finalize(id);
    this.queue.push(report);
    this.wake();
  }
  played(token: OutputToken, samples: number): void {
    const state = this.responses.get(token.responseId);
    if (this.closed || !state?.outputs.includes(token)) return;
    token.played += samples;
    this.check(state);
  }
  private check(state: Response): void {
    if (this.closed || !state.ended || state.interrupted || state.reporting) return;
    if (
      this.mode !== 'discard' &&
      !(
        state.outputs.length &&
        state.outputs.every(
          (o) =>
            !o.invalid && o.generated > 0 && o.generated === o.accepted && o.accepted === o.played,
        )
      )
    )
      return;
    state.reporting = true;
    this.queue.push({
      kind: 'finished',
      response: state.ref,
      playedMs: this.mode === 'discard' ? 0 : state.outputs.reduce((n, o) => n + o.played / 24, 0),
    });
    this.wake();
  }
  private wake(): void {
    if (this.worker) return;
    this.worker = this.drain().finally(() => {
      this.worker = undefined;
    });
    this.spawn(this.worker);
  }
  private async drain(): Promise<void> {
    while (this.queue.length && !this.closed) {
      const report = this.queue.shift()!;
      const id =
        report.kind === 'finished' ? report.response.responseId : report.output.response.responseId;
      if (report.kind === 'finished') {
        const state = this.responses.get(id);
        if (!state || state.interrupted) continue;
        this.finalize(id);
      }
      try {
        await this.report(report);
      } finally {
        this.release(id);
      }
    }
  }
  async settle(): Promise<void> {
    await this.worker;
  }
  private finalize(id: string): void {
    this.finalized.add(id);
    while (this.finalized.size > 256) this.finalized.delete(this.finalized.values().next().value!);
  }
  private release(id: string): void {
    const state = this.responses.get(id);
    if (state) {
      clearTimeout(state.deadline);
      state.hold.release();
      this.responses.delete(id);
    }
  }
  close(): void {
    this.closed = true;
    this.queue = [];
    for (const id of this.responses.keys()) this.release(id);
  }
}
interface Segment {
  token?: OutputToken;
  samples: number;
  duration: number;
  sealed: boolean;
  invalid: boolean;
}

/** Reads frame identity before resampling; ambiguous output retains server estimates. */
export class PrismAudioOutput extends voice.AudioOutput {
  private segments: Segment[] = [];
  private segment?: Segment;
  private resampler?: AudioResampler;
  private format?: string;
  private dropped = 0;
  private flushTask?: Promise<void>;
  private epoch = 0;
  constructor(private output: voice.AudioOutput) {
    super(undefined, undefined, { pause: output.canPause });
    output.on(voice.AudioOutput.EVENT_PLAYBACK_FINISHED, (ev: voice.PlaybackFinishedEvent) =>
      this.finished(ev),
    );
    output.on(voice.AudioOutput.EVENT_PLAYBACK_STARTED, (ev: voice.PlaybackStartedEvent) =>
      this.onPlaybackStarted(ev.createdAt),
    );
    output.on(voice.AudioOutput.EVENT_PLAYBACK_PROGRESSED, (ev: voice.PlaybackProgressedEvent) =>
      this.onPlaybackProgressed(ev),
    );
  }
  override async captureFrame(frame: AudioFrame): Promise<void> {
    if (this.flushTask) {
      await this.flushTask;
      this.flushTask = undefined;
    }
    await super.captureFrame(frame);
    const identity = frame.userdata[KEY] as FrameIdentity | undefined;
    const token = identity?.token;
    if (
      token &&
      (token.owner.closed ||
        identity.offset !== token.accepted ||
        identity.samples !== frame.samplesPerChannel ||
        frame.sampleRate !== 24000 ||
        frame.channels !== 1)
    )
      token.invalid = true;
    if (!this.segment) {
      this.segment = { token, samples: 0, duration: 0, sealed: false, invalid: false };
      if (this.segments.length >= 128) {
        this.dropped += this.segments.length;
        for (const segment of this.segments) if (segment.token) segment.token.invalid = true;
        this.segments = [];
      }
      this.segments.push(this.segment);
    }
    const segment = this.segment;
    if (token !== segment.token || this.dropped) {
      segment.invalid = true;
      if (token) token.invalid = true;
      if (segment.token) segment.token.invalid = true;
    }
    segment.samples += frame.samplesPerChannel;
    segment.duration += frame.samplesPerChannel / frame.sampleRate;
    if (token) token.accepted += frame.samplesPerChannel;
    try {
      if (this.output.sampleRate && this.output.sampleRate !== frame.sampleRate) {
        const format = frame.sampleRate + '/' + frame.channels;
        if (!this.resampler) {
          this.resampler = new AudioResampler(
            frame.sampleRate,
            this.output.sampleRate,
            frame.channels,
          );
          this.format = format;
        } else if (this.format !== format)
          throw new Error('Audio format changed inside a playback segment');
        for (const converted of this.resampler.push(frame))
          await this.output.captureFrame(converted);
      } else await this.output.captureFrame(frame);
    } catch (error) {
      segment.invalid = true;
      if (token) token.invalid = true;
      throw error;
    }
  }
  override flush(): void {
    super.flush();
    const segment = this.segment;
    this.segment = undefined;
    if (segment) segment.sealed = true;
    const resampler = this.resampler;
    this.resampler = undefined;
    if (!resampler) {
      this.output.flush();
      return;
    }
    const epoch = this.epoch;
    this.flushTask = (async () => {
      try {
        for (const frame of resampler.flush()) {
          if (epoch !== this.epoch) return;
          await this.output.captureFrame(frame);
        }
        if (epoch === this.epoch) this.output.flush();
      } catch {
        if (segment?.token) segment.token.invalid = true;
        this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
      } finally {
        resampler.close();
      }
    })();
  }
  override clearBuffer(): void {
    this.epoch++;
    for (const segment of this.segments) {
      segment.invalid = true;
      if (segment.token) segment.token.invalid = true;
    }
    this.resampler?.close();
    this.resampler = undefined;
    this.segment = undefined;
    this.output.clearBuffer();
  }
  private finished(event: voice.PlaybackFinishedEvent): void {
    const segment = this.dropped ? (this.dropped--, undefined) : this.segments.shift();
    if (segment?.token) {
      const token = segment.token;
      if (
        segment.invalid ||
        !segment.sealed ||
        event.interrupted ||
        !Number.isFinite(event.playbackPosition) ||
        event.playbackPosition + 1 / 24000 < segment.duration
      )
        token.invalid = true;
      else token.owner.played(token, segment.samples);
    }
    this.onPlaybackFinished(event);
  }
  override onAttached(): void {
    this.output.onAttached();
  }
  override onDetached(): void {
    this.epoch++;
    this.resampler?.close();
    this.resampler = undefined;
    for (const segment of this.segments) if (segment.token) segment.token.invalid = true;
    this.output.onDetached();
  }
  override pause(): void {
    this.output.pause();
  }
  override resume(): void {
    this.output.resume();
  }
}
