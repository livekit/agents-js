// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { redactReadableSpan } from './redaction.js';

/** Spans held per undecided job; older ones are kept, newer ones dropped past this. */
export const MAX_PENDING_SPANS_PER_JOB = 1024;

interface JobExportState {
  tracesEnabled: boolean;
}

/**
 * Wraps the LiveKit Cloud span exporter so only spans of jobs that registered with traces
 * enabled are uploaded.
 *
 * A job decides whether it records in `session.start()`, but its first spans (`job_entrypoint`,
 * `room_connect`, a stall while models load) end before that. Spans of a job that has started
 * but not decided yet are held here, oldest first up to a bound, and flushed or dropped with the
 * decision; a job that ends without deciding drops them at cleanup. Spans carry their job in
 * the `job_id` attribute the metadata processor stamps.
 */
export class JobSpanGateExporter implements SpanExporter {
  private readonly openJobs = new Set<string>();
  private readonly pending = new Map<string, ReadableSpan[]>();
  private readonly registered = new Map<string, JobExportState>();
  /** Release uploads in flight: started outside the batch processor, so flushed here. */
  private readonly releases = new Set<Promise<void>>();

  constructor(private readonly inner: SpanExporter) {}

  /** The job started; hold its spans until it registers or closes. */
  openJob(jobId: string): void {
    this.openJobs.add(jobId);
  }

  /**
   * The job decided: upload what was held if it records traces, else drop it. `redacted` strips
   * PII from the held spans first: they ended before the job's redaction was known, so the PII
   * processor let it through.
   */
  jobRegistered(jobId: string, options: { tracesEnabled: boolean; redacted?: boolean }): void {
    this.openJobs.delete(jobId);
    this.registered.set(jobId, { tracesEnabled: options.tracesEnabled });
    const held = this.pending.get(jobId) ?? [];
    this.pending.delete(jobId);
    if (!held.length || !options.tracesEnabled) return;
    const spans = options.redacted ? held.map(redactReadableSpan) : held;
    // the batch processor's flush only covers its own batches: keep this upload until it
    // settles so forceFlush() at job exit can wait for it
    const release = new Promise<void>((resolve) => this.inner.export(spans, () => resolve()));
    this.releases.add(release);
    void release.finally(() => this.releases.delete(release));
  }

  /** The job ended; anything still held was never meant to upload. */
  closeJob(jobId: string): void {
    this.openJobs.delete(jobId);
    this.pending.delete(jobId);
    this.registered.delete(jobId);
  }

  /** @internal test hook */
  heldSpans(jobId: string): readonly ReadableSpan[] {
    return this.pending.get(jobId) ?? [];
  }

  /** @internal test hook */
  isOpen(jobId: string): boolean {
    return this.openJobs.has(jobId);
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const exportable: ReadableSpan[] = [];
    for (const span of spans) {
      const jobId = span.attributes.job_id;
      if (typeof jobId !== 'string') continue;
      const state = this.registered.get(jobId);
      if (state) {
        if (state.tracesEnabled) exportable.push(span);
        continue;
      }
      if (this.openJobs.has(jobId)) {
        let held = this.pending.get(jobId);
        if (!held) {
          held = [];
          this.pending.set(jobId, held);
        }
        if (held.length < MAX_PENDING_SPANS_PER_JOB) held.push(span);
      }
    }
    if (!exportable.length) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    this.inner.export(exportable, resultCallback);
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.releases);
    await this.inner.forceFlush?.();
  }
}
