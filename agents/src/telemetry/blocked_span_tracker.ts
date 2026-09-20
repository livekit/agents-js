// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type Context, type Span, trace } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

/**
 * Which span was running when the event loop stalled, without sampling a stack.
 *
 * Every framework span is created and ended on the main thread, so a span created before a
 * stall and ended after it (or at its end, when the blocking call returned) was current while
 * the loop was blocked. The innermost such span, the one created last, is where the stall hurt:
 * `function_tool` for a slow tool, `rpc_handler` for a slow RPC, `on_user_turn_completed` for a
 * slow hook. The Python monitor reads the same span off the blocked task's context; Node has no
 * cross-thread view of a task's context, so the span processor keeps the bookkeeping instead.
 *
 * Creation and end are timed by the wall clock at the processor call, not by the span's own
 * timestamps: a span back-dated at creation (`eou_wait` starts at the user's last speech) must
 * not claim a stall that predates it.
 */
export class BlockedSpanTracker implements SpanProcessor {
  /** Spans not yet ended, by span id. */
  readonly #open = new Map<string, { span: Span; createdAt: number }>();
  /** Spans ended recently: a stall's report runs a heartbeat after the blocking call returned. */
  readonly #ended: { span: Span; createdAt: number; endedAt: number }[] = [];
  readonly #retention: number;
  readonly #maxEnded: number;

  constructor(options: { retention?: number; maxEnded?: number } = {}) {
    this.#retention = options.retention ?? 5_000;
    this.#maxEnded = options.maxEnded ?? 256;
  }

  onStart(span: Span): void {
    this.#open.set(span.spanContext().spanId, { span, createdAt: Date.now() });
  }

  onEnd(span: ReadableSpan): void {
    const id = span.spanContext().spanId;
    const entry = this.#open.get(id);
    if (!entry) return;
    this.#open.delete(id);
    const now = Date.now();
    this.#ended.push({ span: entry.span, createdAt: entry.createdAt, endedAt: now });
    this.#prune(now);
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.#open.clear();
    this.#ended.length = 0;
  }

  /**
   * The innermost span that was current across `[startedAt, endedAt]` (epoch ms): created
   * before the window opened and still open, or ended no earlier than the window closed. Spans
   * of the given names are skipped (the stall span itself). `slack` widens both ends: the
   * block's start is known to within a heartbeat, and its end is the late heartbeat's run, a
   * little after the blocking call returned and the span it was in ended.
   */
  blockedSpan(
    startedAt: number,
    endedAt: number,
    exclude: ReadonlySet<string>,
    slack = 2,
  ): Span | undefined {
    const opened = startedAt + slack;
    const closed = endedAt - slack;
    let best: { span: Span; createdAt: number } | undefined;
    const consider = (entry: { span: Span; createdAt: number }) => {
      if (entry.createdAt > opened) return;
      if (exclude.has(spanName(entry.span))) return;
      // ties (same millisecond) go to the later-created span, which the maps yield last
      if (!best || entry.createdAt >= best.createdAt) best = entry;
    };
    for (const entry of this.#open.values()) consider(entry);
    for (const entry of this.#ended) {
      if (entry.endedAt >= closed) consider(entry);
    }
    return best?.span;
  }

  /** The context carrying {@link blockedSpan}, or undefined. */
  blockedContext(
    startedAt: number,
    endedAt: number,
    exclude: ReadonlySet<string>,
    base: Context,
    slack = 2,
  ): Context | undefined {
    const span = this.blockedSpan(startedAt, endedAt, exclude, slack);
    return span ? trace.setSpan(base, span) : undefined;
  }

  /** @internal test hook */
  get openCount(): number {
    return this.#open.size;
  }

  #prune(now: number): void {
    const cutoff = now - this.#retention;
    while (
      this.#ended.length &&
      (this.#ended[0]!.endedAt < cutoff || this.#ended.length > this.#maxEnded)
    ) {
      this.#ended.shift();
    }
  }
}

function spanName(span: Span): string {
  return (span as { name?: string }).name ?? '';
}

/** The one tracker the loop monitor consults; installed on every provider the framework owns. */
export const blockedSpanTracker = new BlockedSpanTracker();
