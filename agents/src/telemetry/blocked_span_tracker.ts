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
   * The span that was current when the loop began blocking within `[startedAt, endedAt]` (epoch
   * ms): created before the window opened and still open, or ended after its first heartbeat.
   * Spans of the given names are skipped (the stall span itself). `slack` accounts for heartbeat
   * timing at both ends. The late heartbeat can run well after the blocking call and its span
   * ended, so requiring a span to cover the report's end would discard the actual blocker.
   *
   * Only spans of `traceId` qualify when given: the processor sees every span of the provider,
   * and a span of an unrelated trace (an application's own HTTP request, say) that happened to
   * be open must not pull the stall out of the job's trace.
   *
   * Among the spans that qualify, the innermost of one ancestry is the answer. When two
   * operations of the same kind were both in flight (two tools, two RPC handlers), timing alone
   * cannot say which one blocked: the answer is then their nearest common ancestor, or nothing,
   * rather than a guess at one of them. Operations of different kinds overlap all the time (a
   * user turn is open while an RPC handler runs, an audio wait while an RPC blocks) and the
   * newest of them is taken to be the one that blocked. That is a guess too: a tool awaiting
   * I/O can resume and block while a newer RPC handler is itself awaiting I/O, and the RPC gets
   * the blame. The alternative, their common ancestor, would file every stall during a wait
   * under the session, so the guess is kept.
   */
  blockedSpan(
    startedAt: number,
    endedAt: number,
    exclude: ReadonlySet<string>,
    slack = 2,
    traceId?: string,
  ): Span | undefined {
    const opened = startedAt + slack;
    const closed = Math.min(endedAt - slack, startedAt + slack);
    const candidates = new Map<string, { span: Span; createdAt: number }>();
    const consider = (entry: { span: Span; createdAt: number }) => {
      if (entry.createdAt > opened) return;
      if (exclude.has(spanName(entry.span))) return;
      if (traceId !== undefined && entry.span.spanContext().traceId !== traceId) return;
      candidates.set(entry.span.spanContext().spanId, entry);
    };
    for (const entry of this.#open.values()) consider(entry);
    for (const entry of this.#ended) {
      if (entry.endedAt >= closed) consider(entry);
    }
    if (!candidates.size) return undefined;

    // the leaves: candidates no other candidate descends from
    const hasChild = new Set<string>();
    for (const entry of candidates.values()) {
      let parent = parentSpanId(entry.span);
      while (parent !== undefined && candidates.has(parent) && !hasChild.has(parent)) {
        hasChild.add(parent);
        parent = parentSpanId(candidates.get(parent)!.span);
      }
    }
    const leaves = [...candidates.entries()].filter(([id]) => !hasChild.has(id));
    // ties (same millisecond) go to the later-created span, which the maps yield last
    let newest = leaves[0]!;
    for (const leaf of leaves) if (leaf[1].createdAt >= newest[1].createdAt) newest = leaf;
    const sameKind = leaves.filter(
      ([, entry]) => spanName(entry.span) === spanName(newest[1].span),
    );
    if (sameKind.length <= 1) return newest[1].span;

    // indistinguishable: the nearest ancestor (among the candidates) common to all of them
    const chains = sameKind.map(([id]) => {
      const chain: string[] = [];
      let current: string | undefined = id;
      while (current !== undefined && candidates.has(current)) {
        chain.push(current);
        current = parentSpanId(candidates.get(current)!.span);
      }
      return chain;
    });
    const shared = chains[0]!.find((id) => chains.every((chain) => chain.includes(id)));
    if (shared === undefined) return undefined;
    // the common ancestor is the deepest one of that kind that is not itself ambiguous
    return candidates.get(shared)!.span;
  }

  /**
   * The context carrying {@link blockedSpan}, or undefined. Candidates are confined to `base`'s
   * trace (the session's or the job's) when it carries one.
   */
  blockedContext(
    startedAt: number,
    endedAt: number,
    exclude: ReadonlySet<string>,
    base: Context,
    slack = 2,
  ): Context | undefined {
    const traceId = trace.getSpanContext(base)?.traceId;
    const span = this.blockedSpan(startedAt, endedAt, exclude, slack, traceId);
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

function parentSpanId(span: Span): string | undefined {
  return (span as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId;
}

/** The one tracker the loop monitor consults; installed on every provider the framework owns. */
export const blockedSpanTracker = new BlockedSpanTracker();
