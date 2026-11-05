// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as r from '@rimelabs/sdk';

export type PlaybackMode = 'auto' | 'estimated' | 'discard';

/** Owns explicit discard and interruption reports. Normal output uses provider estimates. */
export class Playback {
  private responses = new Map<string, { ref: r.ResponseRef; hold: r.ResponseHold }>();
  private finalized = new Set<string>();
  private queue: r.PlaybackReport[] = [];
  private worker?: Promise<void>;
  private closed = false;
  constructor(
    private sdk: r.RealtimeSession,
    private mode: PlaybackMode,
    private report: (report: r.PlaybackReport) => Promise<void>,
    private spawn: (work: Promise<void>) => void,
  ) {}
  start(ref: r.ResponseRef): void {
    if (this.mode !== 'discard' || this.closed || this.responses.has(ref.responseId)) return;
    if (this.responses.size >= 128) return;
    this.responses.set(ref.responseId, { ref, hold: this.sdk.holdResponse(ref) });
  }
  end(ref: r.ResponseRef, interrupted = false): void {
    if (this.closed || !this.responses.has(ref.responseId)) return;
    if (interrupted) {
      this.release(ref.responseId);
      return;
    }
    this.enqueue({ kind: 'finished', response: ref, playedMs: 0 });
  }
  interrupt(report: r.PlaybackInterrupted): void {
    this.enqueue(report);
  }
  private enqueue(report: r.PlaybackReport): void {
    const id =
      report.kind === 'finished' ? report.response.responseId : report.output.response.responseId;
    if (this.closed || this.finalized.has(id)) return;
    this.finalized.add(id);
    while (this.finalized.size > 256) this.finalized.delete(this.finalized.values().next().value!);
    this.queue.push(report);
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
  private release(id: string): void {
    this.responses.get(id)?.hold.release();
    this.responses.delete(id);
  }
  close(): void {
    this.closed = true;
    this.queue = [];
    for (const id of this.responses.keys()) this.release(id);
  }
}
