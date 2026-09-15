// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The shape every livekit-agents trace must have, and a checker that applies it.
 *
 * The nesting of spans is an emergent property of many call sites, and a refactor can move a
 * span under the wrong parent while every existing test still passes, because each test only
 * names the one edge it cares about. This module writes the rules down once:
 *
 * - {@link SPAN_PARENTS}: for each span name, the parents it may have (`ROOT` for none).
 * - {@link MAY_OUTLIVE_PARENT}: the few child/parent edges where the child is allowed to end
 *   after its parent, each with the reason. Everything else must sit inside its parent.
 * - {@link checkTrace}: applies those rules plus the per-turn invariants (one `agent_turn` per
 *   speech, its own generation events matching `lk.generation_count`) and returns the
 *   violations.
 *
 * It reads spans from an in-memory exporter (the fake-session tests) or from an OTLP/JSON export
 * downloaded from LiveKit Cloud, so the same rules check a unit test and a real run:
 *
 * ```
 * pnpm exec tsx agents/src/telemetry/testing/trace_schema.ts path/to/traces.json
 * ```
 *
 * Adding a span means adding a row here. Moving one without updating the row fails every test
 * that calls {@link assertTraceWellFormed}.
 *
 * Test support: imported by tests only, not exported from the package. Kept free of framework
 * imports so the CLI runs on the source file directly.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Allowed parent meaning "no parent at all". */
export const ROOT = null;

/** Allowed parent meaning "whatever was current": spans that follow their caller. */
export const ANY = '*';

export type AllowedParent = string | typeof ROOT;

/** 2 ms of slack for clocks read on either side of a span boundary. */
export const TOLERANCE_MS = 2;

const parents = (...names: AllowedParent[]): ReadonlySet<AllowedParent> => new Set(names);

export const SPAN_PARENTS: ReadonlyMap<string, ReadonlySet<AllowedParent>> = new Map<
  string,
  ReadonlySet<AllowedParent>
>([
  // -- the job (ipc/job_proc_lazy_main, ipc/job_trace, job_lifecycle)
  ['job_entrypoint', parents(ROOT)],
  ['job_shutdown', parents('job_entrypoint')],
  ['on_session_end', parents('job_shutdown')],
  ['session_end_upload', parents('job_shutdown')],
  ['room_disconnect', parents('job_shutdown')],
  ['shutdown_callback', parents('job_shutdown')],
  // -- the session (voice/agent_session); ROOT outside a job (tests, integrators)
  ['agent_session', parents('job_entrypoint', ROOT)],
  ['session_start', parents('agent_session')],
  ['session_close', parents('agent_session')],
  ['update_agent', parents('agent_session')],
  // -- startup work: under session_start while the session starts, under the job before
  ['room_connect', parents('session_start', 'job_entrypoint')],
  ['wait_for_participant', parents('session_start', 'job_entrypoint')],
  ['wait_for_audio_track', parents('session_start', 'agent_session')],
  ['publish_audio_output', parents('session_start')],
  // -- agent activity lifecycle
  ['start_agent_activity', parents('session_start', 'update_agent')],
  ['setup_toolsets', parents('start_agent_activity')],
  ['on_enter', parents('start_agent_activity')],
  ['pause_agent_activity', parents('update_agent')],
  ['resume_agent_activity', parents('update_agent')],
  ['drain_agent_activity', parents('update_agent', 'session_close', 'agent_session')],
  ['on_exit', parents('drain_agent_activity')],
  // -- the user's turn
  ['user_turn', parents('agent_session')],
  ['user_speaking', parents('user_turn', 'agent_session')],
  ['eou_wait', parents('user_turn')],
  ['eou_detection', parents('eou_wait')],
  ['on_user_turn_completed', parents('user_turn', 'agent_session')],
  // -- the agent's turn: one per speech handle, every generation inside it
  ['agent_turn', parents('agent_session')],
  ['llm_node', parents('agent_turn')],
  ['tts_node', parents('agent_turn')],
  ['function_tool', parents('agent_turn')],
  ['agent_speaking', parents('agent_turn')],
  ['realtime_inference', parents('agent_turn')],
  ['realtime_metrics', parents('realtime_inference', 'agent_turn')],
  // -- model requests: under the node that made them, or the feature that owns them. An
  // adapter (LLM/TTS FallbackAdapter, TTS StreamAdapter) is itself an LLM/TTS, so its request
  // span stands in for the provider's; each attempt (`*_request_run`) opens the wrapped stream,
  // whose own request span nests inside it:
  //   llm_request (adapter) → llm_request_run → llm_request (provider) → llm_request_run
  [
    'llm_request',
    parents('llm_node', 'llm_request_run', 'keyterm_detection', 'answering_machine_detection'),
  ],
  ['llm_request_run', parents('llm_request')],
  ['tts_request', parents('tts_node', 'tts_request_run')],
  ['tts_request_run', parents('tts_request')],
  // -- session-scoped features
  ['keyterm_detection', parents('agent_turn', 'agent_session')],
  ['answering_machine_detection', parents('agent_session')],
  // -- RPC: handlers are session events, calls follow their caller. Before or after the session
  // a handler lands under the job; outside a job (an integrator's RoomIO) the SDK dispatches on
  // a context carrying no span.
  ['rpc_handler', parents('agent_session', 'job_entrypoint', ROOT)],
  ['rpc_call', parents(ANY)],
  // -- a stall lands under whatever was blocked (any span), or the session/job
  ['event_loop_blocked', parents(ANY)],
]);

/**
 * Child/parent edges where the child may end after its parent, with the reason. Deliberate:
 * each is a known property of the code, and a viewer draws them poking out of the parent.
 */
export const MAY_OUTLIVE_PARENT: ReadonlyMap<string, string> = new Map([
  [
    edge('wait_for_participant', 'session_start'),
    'session.start() returns before a participant is linked',
  ],
  [edge('wait_for_audio_track', 'session_start'), 'session.start() returns before the first frame'],
  [
    edge('publish_audio_output', 'session_start'),
    'session.start() returns before the track is published',
  ],
  [
    edge('on_enter', 'start_agent_activity'),
    'on_enter runs as a task the activity does not wait for',
  ],
  [
    edge('event_loop_blocked', ANY),
    'the heartbeat notices a stall one tick after the blocked call returned',
  ],
  [
    edge('keyterm_detection', 'agent_turn'),
    'the pass runs alongside the reply and can outlast a short or interrupted turn',
  ],
]);

/** The key of a child/parent edge in {@link MAY_OUTLIVE_PARENT}. */
export function edge(child: string, parent: string): string {
  return `${child} -> ${parent}`;
}

export interface EventRecord {
  name: string;
  attributes: Record<string, unknown>;
}

/** The part of a span the rules look at, from either source. Times are epoch milliseconds. */
export interface SpanRecord {
  name: string;
  spanId: string;
  parentId: string | undefined;
  traceId: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, unknown>;
  events: EventRecord[];
}

/** What the rules read off an OpenTelemetry SDK `ReadableSpan`, spelled structurally. */
export interface ReadableSpanLike {
  readonly name: string;
  spanContext(): { spanId: string; traceId: string };
  readonly parentSpanContext?: { spanId: string };
  readonly startTime: [number, number];
  readonly endTime: [number, number];
  readonly attributes: Record<string, unknown>;
  readonly events: readonly { name: string; attributes?: Record<string, unknown> }[];
}

function hrTimeMs(time: [number, number]): number {
  return time[0] * 1000 + time[1] / 1e6;
}

/** Records from OpenTelemetry SDK `ReadableSpan` objects (an in-memory exporter). */
export function fromReadableSpans(spans: Iterable<ReadableSpanLike>): SpanRecord[] {
  const out: SpanRecord[] = [];
  for (const span of spans) {
    const ctx = span.spanContext();
    out.push({
      name: span.name,
      spanId: ctx.spanId,
      parentId: span.parentSpanContext?.spanId,
      traceId: ctx.traceId,
      startMs: hrTimeMs(span.startTime),
      endMs: hrTimeMs(span.endTime),
      attributes: { ...span.attributes },
      events: span.events.map((event) => ({
        name: event.name,
        attributes: { ...(event.attributes ?? {}) },
      })),
    });
  }
  return out;
}

type OtlpValue = Record<string, unknown>;

function otlpValue(value: OtlpValue): unknown {
  if ('stringValue' in value) return value.stringValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('boolValue' in value) return Boolean(value.boolValue);
  if ('arrayValue' in value) {
    const values = (value.arrayValue as { values?: OtlpValue[] }).values ?? [];
    return values.map(otlpValue);
  }
  return value;
}

function otlpAttributes(item: { attributes?: { key: string; value: OtlpValue }[] }) {
  const out: Record<string, unknown> = {};
  for (const attr of item.attributes ?? []) out[attr.key] = otlpValue(attr.value);
  return out;
}

function unixNanoMs(value: unknown): number {
  // int64 as a decimal string in OTLP/JSON; BigInt keeps the nanoseconds exact before the
  // division, since epoch nanoseconds exceed the double's integer range
  return Number(BigInt(String(value))) / 1e6;
}

interface OtlpSpan {
  name: string;
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  startTimeUnixNano: string | number;
  endTimeUnixNano: string | number;
  attributes?: { key: string; value: OtlpValue }[];
  events?: { name: string; attributes?: { key: string; value: OtlpValue }[] }[];
}

interface OtlpDocument {
  resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[];
}

/** Records from an OTLP/JSON export (`resourceSpans` → `scopeSpans` → `spans`), or its path. */
export function fromOtlpJson(document: OtlpDocument | string): SpanRecord[] {
  const doc: OtlpDocument =
    typeof document === 'string'
      ? (JSON.parse(readFileSync(document, 'utf8')) as OtlpDocument)
      : document;
  const out: SpanRecord[] = [];
  for (const resourceSpans of doc.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        out.push({
          name: span.name,
          spanId: span.spanId,
          parentId: span.parentSpanId || undefined,
          traceId: span.traceId,
          startMs: unixNanoMs(span.startTimeUnixNano),
          endMs: unixNanoMs(span.endTimeUnixNano),
          attributes: otlpAttributes(span),
          events: (span.events ?? []).map((event) => ({
            name: event.name,
            attributes: otlpAttributes(event),
          })),
        });
      }
    }
  }
  return out;
}

export interface CheckTraceOptions {
  /** Clock slack, in milliseconds, for the bounds checks. */
  toleranceMs?: number;
  /**
   * For partial exports (a view keyed to one span drops the ancestors): a span whose parent is
   * absent is then checked as if it were a root.
   */
  allowMissingParents?: boolean;
}

function showParent(parent: AllowedParent): string {
  return parent === ROOT ? 'ROOT' : parent;
}

/** Every way the spans break the rules, as one line each; empty when the trace is sound. */
export function checkTrace(
  spans: readonly SpanRecord[],
  options: CheckTraceOptions = {},
): string[] {
  const { toleranceMs = TOLERANCE_MS, allowMissingParents = false } = options;
  const violations: string[] = [];
  const byId = new Map(spans.map((span) => [span.spanId, span]));

  const traceIds = new Set(spans.map((span) => span.traceId));
  if (traceIds.size > 1) {
    violations.push(`spans belong to ${traceIds.size} traces, expected one`);
  }

  for (const span of spans) {
    const allowed = SPAN_PARENTS.get(span.name);
    if (allowed === undefined) {
      violations.push(`${span.name}: unknown span, add it to trace_schema SPAN_PARENTS`);
      continue;
    }
    const parent = span.parentId ? byId.get(span.parentId) : undefined;
    if (span.parentId && parent === undefined) {
      if (!allowMissingParents) {
        violations.push(`${span.name}: parent ${span.parentId} is not in the trace`);
      }
      continue; // a partial export: nothing to check the edge against
    }
    const parentName: AllowedParent = parent ? parent.name : ROOT;
    if (!allowed.has(ANY) && !allowed.has(parentName)) {
      const shown = parentName === ROOT ? 'no parent' : parentName;
      violations.push(
        `${span.name}: parent is ${shown}, allowed: ${[...allowed].map(showParent).sort().join(', ')}`,
      );
    }
    if (parent) {
      if (span.startMs + toleranceMs < parent.startMs) {
        violations.push(
          `${span.name}: starts ${(parent.startMs - span.startMs).toFixed(1)} ms before its ` +
            `parent ${parent.name}`,
        );
      }
      const overrun = span.endMs - parent.endMs;
      if (
        overrun > toleranceMs &&
        !MAY_OUTLIVE_PARENT.has(edge(span.name, parent.name)) &&
        !MAY_OUTLIVE_PARENT.has(edge(span.name, ANY))
      ) {
        violations.push(
          `${span.name}: ends ${overrun.toFixed(1)} ms after its parent ${parent.name}`,
        );
      }
    }
  }

  // one agent_turn per speech handle, and its generations accounted for
  const speechTurns = new Map<string, SpanRecord[]>();
  for (const span of spans) {
    if (span.name !== 'agent_turn') continue;
    const speechId = String(span.attributes['lk.speech_id'] ?? '');
    if (!speechId) {
      violations.push('agent_turn: no lk.speech_id');
      continue;
    }
    speechTurns.set(speechId, [...(speechTurns.get(speechId) ?? []), span]);
    // a preemptive attempt discarded for this speech left its generations on the span too; the
    // count is the finishing speech's own steps
    const ownGenerations = span.events.filter(
      (event) =>
        event.name === 'generation' &&
        String(event.attributes['lk.generation_id'] ?? `${speechId}_`).startsWith(`${speechId}_`),
    ).length;
    const count = span.attributes['lk.generation_count'];
    const countOk =
      (typeof count === 'number' || typeof count === 'string') &&
      Number.isInteger(Number(count)) &&
      Number(count) === ownGenerations;
    if (!countOk) {
      violations.push(
        `agent_turn ${speechId}: lk.generation_count=${JSON.stringify(count)} but ` +
          `${ownGenerations} of its own generation events`,
      );
    }
  }
  for (const [speechId, turns] of speechTurns) {
    if (turns.length > 1) {
      violations.push(`agent_turn: speech ${speechId} has ${turns.length} turns, expected one`);
    }
  }

  // a wait always ends with an outcome (eou_detection never running outside one is a parent rule)
  for (const span of spans) {
    if (span.name === 'eou_wait' && !('lk.eou.outcome' in span.attributes)) {
      violations.push('eou_wait: no lk.eou.outcome');
    }
  }

  return violations;
}

/** For tests: `spans` are `ReadableSpan` objects from an in-memory exporter. */
export function assertTraceWellFormed(
  spans: Iterable<ReadableSpanLike>,
  options: CheckTraceOptions = {},
): void {
  const violations = checkTrace(fromReadableSpans(spans), options);
  if (violations.length) {
    throw new Error(`trace shape violations:\n  ${violations.join('\n  ')}`);
  }
}

function summary(spans: readonly SpanRecord[]): string {
  const counts = new Map<string, number>();
  for (const span of spans) counts.set(span.name, (counts.get(span.name) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}×${count}`)
    .join(', ');
}

/** The CLI: print the span summary and the violations of an OTLP/JSON export. */
export function main(argv: readonly string[]): number {
  if (argv.length !== 1) {
    console.error('usage: tsx agents/src/telemetry/testing/trace_schema.ts <traces.json>');
    return 2;
  }
  const records = fromOtlpJson(argv[0]!);
  console.log(`${records.length} spans: ${summary(records)}`);
  const violations = checkTrace(records, { allowMissingParents: true });
  if (!violations.length) {
    console.log('trace shape OK');
    return 0;
  }
  console.log(`${violations.length} violation(s):`);
  for (const violation of violations) console.log(`  - ${violation}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
