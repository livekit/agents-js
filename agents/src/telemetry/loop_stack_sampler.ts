// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Stack samples for event loop stalls, taken from the watchdog thread.
 *
 * The Python monitor's watchdog thread reads the loop thread's stack with
 * `sys._current_frames()`. Node has no cross-thread stack read, but a worker thread can attach an
 * inspector session to the main thread (`Session.connectToMainThread`) and, with the debugger
 * domain enabled, ask it to pause: V8 honours `Debugger.pause` at the next interrupt check even
 * inside a spinning script, hands the session the full call stack (function names, files, lines,
 * for optimized code too), and resumes on request about a millisecond later. Enabling the
 * debugger domain costs a one-time enumeration of the loaded scripts on the main thread (tens of
 * milliseconds with the framework loaded) and about 1% of throughput afterwards; a pause costs
 * only when a stall is under way.
 *
 * What it cannot see: a native call that does not check for interrupts (a sync file or
 * child-process call, a native addon; `Atomics.wait` does check) keeps the pause waiting until
 * the call returns. The sample then shows the caller, still in the frame that made the call,
 * which is what the Python watchdog sees once a native call releases the GIL. Only a pause that
 * lands after the loop has moved on to other work is discarded, with a note.
 *
 * V8's sampling profiler was the first choice and does capture native calls, but on Node 24
 * only the first profile of a process names code optimized before it started: every later
 * profile attributes a hot function's samples to its caller, and reading samples means
 * restarting the profile. Not usable for repeated captures.
 */
import { log } from '../log.js';
import type { StackSamplingMode } from './loop_monitor.js';

/** Innermost frames kept per sample, as in the Python monitor. */
export const MAX_STACK_FRAMES = 20;
/** A second sample this many warn thresholds into a stall, so a long block gets a second look. */
export const LATE_SAMPLE_FACTOR = 10;

export const ENV_STACKS = 'LIVEKIT_AGENTS_LOOP_BLOCK_STACKS';

export function stackSamplingModeFromEnv(env: NodeJS.ProcessEnv = process.env): StackSamplingMode {
  const raw = env[ENV_STACKS]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return 'adaptive';
  if (raw === '1' || raw === 'always' || raw === 'true') return 'always';
  if (raw === '0' || raw === 'never' || raw === 'false') return 'never';
  if (raw === 'adaptive') return 'adaptive';
  log().warn(
    { value: raw },
    `invalid ${ENV_STACKS}, expected adaptive, always or never; using adaptive`,
  );
  return 'adaptive';
}

/** One frame of a sampled stack, innermost first in {@link StackSample.frames}. */
export interface StackFrame {
  functionName: string;
  url: string;
  /** 1-based, 0 when unknown. */
  line: number;
  column: number;
}

export interface StackSample {
  /** Milliseconds into the stall the loop thread was paused. */
  offset: number;
  /** When the pause landed, epoch ms: past the stall's end, the loop was in a native call. */
  pausedAt: number;
  /** Innermost first. */
  frames: StackFrame[];
}

// -- the worker side ------------------------------------------------------------------------

/** Slots of the SharedArrayBuffer shared with the watchdog thread (Date.now() ms as BigInt). */
export const WD_LAST_WAKE = 0;
export const WD_LATE_AT = 1;
export const WD_LATE_GAP = 2;
/** The main thread's last heartbeat, written by the monitor: the watchdog measures the lag from it. */
export const WD_MAIN_LAST_TICK = 3;
export const WD_SLOTS = 4;

/** Messages from the watchdog thread. */
export type WatchdogMessage =
  | { type: 'sampling_started'; from: number; to: number }
  | { type: 'sampling_unavailable'; reason: string }
  | { type: 'stall_sample'; windowStart: number; sample: StackSample };

/** Messages to the watchdog thread. */
export type WatchdogCommand = { type: 'enable_sampling' };

/**
 * The watchdog thread. Every `interval` ms it records its own wake-up (late wake-ups mean the
 * process was not scheduled) and, once sampling is enabled, checks how late the main thread's
 * heartbeat is: at the warn threshold it pauses the main thread through the inspector and posts
 * the stack, and again at {@link LATE_SAMPLE_FACTOR} times the threshold if the stall goes on.
 * Written as a plain script for `new Worker(source, { eval: true })`, so it bundles with the
 * package as a string.
 */
export const WATCHDOG_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const state = new BigInt64Array(workerData.shared);
const { interval, warnThreshold, lateFactor } = workerData;
let before = Date.now();

// -- host contention: the watchdog's own late wake-ups
setInterval(() => {
  const now = Date.now();
  const gap = now - before - interval;
  before = now;
  if (gap > Number(Atomics.load(state, ${WD_LATE_GAP}))) {
    Atomics.store(state, ${WD_LATE_AT}, BigInt(now));
    Atomics.store(state, ${WD_LATE_GAP}, BigInt(gap));
  }
  Atomics.store(state, ${WD_LAST_WAKE}, BigInt(now));
  if (session) void checkStall(now);
}, interval);

// -- stack sampling: pause the main thread at the warn threshold, and once more much later
let session;
let pausing;            // the sample being taken
let incident;           // { windowStart, first: boolean, late: boolean }
const scripts = new Map(); // script id -> url, for frames whose url V8 leaves empty (vm scripts)

function post(method, params) {
  return new Promise((resolve, reject) =>
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result))),
  );
}

async function enable() {
  if (session) return;
  const inspector = require('node:inspector');
  const s = new inspector.Session();
  s.connectToMainThread();
  s.on('Debugger.scriptParsed', (event) => {
    if (event.params.url) scripts.set(event.params.scriptId, event.params.url);
  });
  s.on('Debugger.paused', (event) => {
    if (pausing) {
      pausing.resolve(event.params);
    } else {
      // a debugger statement in user code, or a breakpoint: nothing here can act on it
      s.post('Debugger.resume', () => undefined);
    }
  });
  const from = Date.now();
  session = s;
  try {
    await post('Debugger.enable');
    parentPort.postMessage({ type: 'sampling_started', from, to: Date.now() });
  } catch (error) {
    session = undefined;
    parentPort.postMessage({ type: 'sampling_unavailable', reason: String(error) });
  }
}

async function checkStall(now) {
  if (pausing) return;
  const mainLastTick = Number(Atomics.load(state, ${WD_MAIN_LAST_TICK}));
  if (!mainLastTick) return;
  const lag = now - (mainLastTick + interval);
  if (lag < warnThreshold) {
    incident = undefined;
    return;
  }
  if (!incident || incident.windowStart !== mainLastTick) {
    incident = { windowStart: mainLastTick, first: false, late: false };
  }
  const wantFirst = !incident.first;
  const wantLate = !incident.late && lag >= warnThreshold * lateFactor;
  if (!wantFirst && !wantLate) return;
  if (wantFirst) incident.first = true;
  if (wantLate) incident.late = true;
  const sample = await pauseMainThread();
  if (sample) {
    parentPort.postMessage({
      type: 'stall_sample',
      windowStart: incident.windowStart,
      sample: { ...sample, offset: sample.pausedAt - incident.windowStart },
    });
  }
}

async function pauseMainThread() {
  let resolve;
  const paused = new Promise((r) => (resolve = r));
  pausing = { resolve };
  try {
    await post('Debugger.pause');
    const params = await paused;
    const pausedAt = Date.now();
    const frames = params.callFrames.slice(0, ${MAX_STACK_FRAMES}).map((frame) => ({
      functionName: frame.functionName || '',
      url: frame.url || scripts.get(frame.location.scriptId) || '',
      line: frame.location.lineNumber >= 0 ? frame.location.lineNumber + 1 : 0,
      column: frame.location.columnNumber >= 0 ? frame.location.columnNumber + 1 : 0,
    }));
    await post('Debugger.resume');
    return { pausedAt, frames };
  } catch {
    return undefined;
  } finally {
    pausing = undefined;
  }
}

parentPort.on('message', (command) => {
  if (command && command.type === 'enable_sampling') void enable();
});
if (workerData.samplingEnabled) void enable();
`;

// -- formatting -----------------------------------------------------------------------------

// the framework's job runner: everything outer than its innermost frame is the same in every
// sample (the process bootstrap, the entrypoint wrapper), like the Python monitor's `ipc/` cut.
// The framework is recognised by its built package path (installed, or linked from a workspace
// checkout); its own tests run from source and count as user code
const RUNNER_PATH = /[/\\](agents[/\\]dist|@livekit[/\\]agents[/\\]dist)[/\\]ipc[/\\]/;
const FRAMEWORK_PATH = /[/\\](agents[/\\]dist|@livekit[/\\]agents[/\\]dist)[/\\]/;

function isNodeInternal(frame: StackFrame): boolean {
  return frame.url.startsWith('node:');
}

function fileOf(frame: StackFrame): string {
  return frame.url.startsWith('file://') ? decodeURIComponent(frame.url.slice(7)) : frame.url;
}

function formatFrame(frame: StackFrame): string {
  const name = frame.functionName || '(anonymous)';
  if (!frame.url) return `    at ${name} (native)`;
  return `    at ${name} (${fileOf(frame)}:${frame.line}:${frame.column})`;
}

/**
 * Format one sample like the Python monitor formats one of its: a header saying when in the
 * stall it was taken, then the innermost {@link MAX_STACK_FRAMES} frames, innermost first.
 * Node's own internals (the timer and promise machinery, the same in every sample) are dropped
 * except as the innermost frame, and everything outer than the framework's job runner is cut.
 */
export function formatSample(sample: StackSample): string {
  let frames = sample.frames.filter((frame, i) => i === 0 || !isNodeInternal(frame));
  const runner = frames.findIndex((frame) => RUNNER_PATH.test(frame.url));
  if (runner > 0) frames = frames.slice(0, runner);
  const lines = frames.slice(0, MAX_STACK_FRAMES).map(formatFrame);
  return `# loop thread sampled ${sample.offset.toFixed(0)}ms into the stall\n${lines.join('\n')}`;
}

/**
 * The innermost frame of a sample that is the agent's or a library's own code, skipping Node's
 * internals and the framework: the actionable location, for the log line.
 */
export function innermostLocation(sample: StackSample): string | undefined {
  const own = sample.frames.find(
    (frame) => frame.url && !isNodeInternal(frame) && !FRAMEWORK_PATH.test(frame.url),
  );
  const frame = own ?? sample.frames.find((frame) => frame.url) ?? sample.frames[0];
  if (!frame) return undefined;
  const name = frame.functionName || '(anonymous)';
  if (!frame.url) return `${name} (native)`;
  return `${name} (${fileOf(frame)}:${frame.line})`;
}
