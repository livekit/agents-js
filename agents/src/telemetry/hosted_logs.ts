// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { version } from '../version.js';
import { REDACTED_EXCEPTION_MESSAGE, isPIIAttribute } from './redaction.js';

export const HOSTED_LOGS_ENV = 'LIVEKIT_HOSTED_LOGS';
export const HOSTED_LOGS_ENABLED = 'true';
export const HOSTED_LOGS_HANDOFF_FILE_ENV = 'LIVEKIT_HOSTED_LOGS_HANDOFF_FILE';
export const HOSTED_LOGS_JOBS_DIR_ENV = 'LIVEKIT_HOSTED_LOGS_JOBS_DIR';
export const HANDED_OFF_ENV = 'LIVEKIT_HOSTED_LOGS_HANDED_OFF';

const REDACTION_ATTRIBUTE = 'lk.redaction.enabled';

/** The session's logs decision, as named in `job-<id>.<decision>.log`. */
export enum LogsDecision {
  PRIVATE = 'private',
  EXPORT = 'export',
}

function enabled(): boolean {
  return process.env[HOSTED_LOGS_ENV] === HOSTED_LOGS_ENABLED;
}

function handoffFile(): string | undefined {
  return enabled() ? process.env[HOSTED_LOGS_HANDOFF_FILE_ENV] || undefined : undefined;
}

function jobsDir(): string | undefined {
  return enabled() ? process.env[HOSTED_LOGS_JOBS_DIR_ENV] || undefined : undefined;
}

/** Write the hand-off file, which tells LiveKit Cloud to collect logs and stops OTLP export. */
export function handOffLogs(): void {
  const path = handoffFile();
  const dir = jobsDir();
  if (path === undefined || dir === undefined || process.env[HANDED_OFF_ENV] === '1') {
    return;
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify({ sdk: 'node', version }));
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
    return;
  }
  process.env[HANDED_OFF_ENV] = '1';
}

/** Whether this process, or the worker that forked it, handed log collection to LiveKit Cloud. */
export function logsHandedOff(): boolean {
  return (
    handoffFile() !== undefined && jobsDir() !== undefined && process.env[HANDED_OFF_ENV] === '1'
  );
}

function decision(logs: boolean): LogsDecision {
  return logs ? LogsDecision.EXPORT : LogsDecision.PRIVATE;
}

function redactException(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const exception = value as Record<string, unknown>;
  if (typeof exception.type !== 'string' || typeof exception.message !== 'string') {
    return value;
  }
  return { type: exception.type, message: REDACTED_EXCEPTION_MESSAGE };
}

/** The record without PII fields or exception details, marked as redacted. */
export function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isPIIAttribute(key)) continue;
    redacted[key] = key === 'err' || key === 'error' ? redactException(value) : value;
  }
  redacted[REDACTION_ATTRIBUTE] = true;
  return redacted;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The log file of a job process. JSON log records are held until the session's decision, then
 * written, redacted when the job requires it; other output is written as it arrives.
 */
export class JobOutput {
  #path: string;
  #jobId: string;
  #fd: number | undefined;
  #decided = false;
  #held: string[] | undefined = [];
  #partial = new Map<string, string>();
  redaction: boolean;

  constructor(path: string, jobId: string, fd: number, redaction: boolean) {
    this.#path = path;
    this.#jobId = jobId;
    this.#fd = fd;
    this.redaction = redaction;
  }

  get decided(): boolean {
    return this.#decided;
  }

  /** Write text from one stream, one complete line at a time, so lines don't tear. */
  write(stream: string, text: string): void {
    const pending = (this.#partial.get(stream) ?? '') + text;
    const end = pending.lastIndexOf('\n');
    if (end === -1) {
      this.#partial.set(stream, pending);
      return;
    }
    this.#partial.set(stream, pending.slice(end + 1));
    for (const line of pending.slice(0, end).split('\n')) {
      this.#line(line);
    }
  }

  decide({ logs, redaction }: { logs: boolean; redaction: boolean }): void {
    if (this.#decided) return;
    this.#decided = true;
    this.redaction = this.redaction || redaction;
    const newPath = join(dirname(this.#path), `job-${this.#jobId}.${decision(logs)}.log`);
    try {
      renameSync(this.#path, newPath);
      this.#path = newPath;
    } catch {
      this.#close();
    }
    const held = this.#held ?? [];
    this.#held = undefined;
    for (const line of held) {
      this.#writeRecord(line);
    }
  }

  /** Write any partial lines; records still held without a decision are never written. */
  close(): void {
    for (const rest of this.#partial.values()) {
      if (rest) this.#line(rest);
    }
    this.#partial.clear();
    this.#close();
  }

  #line(line: string): void {
    if (parseRecord(line) === undefined) {
      this.#writeRaw(line);
    } else if (this.#held !== undefined) {
      this.#held.push(line);
    } else {
      this.#writeRecord(line);
    }
  }

  #writeRecord(line: string): void {
    const record = parseRecord(line);
    this.#writeRaw(record && this.redaction ? JSON.stringify(redactRecord(record)) : line);
  }

  #writeRaw(line: string): void {
    if (this.#fd === undefined) return;
    try {
      writeSync(this.#fd, line + '\n');
    } catch {}
  }

  #close(): void {
    if (this.#fd === undefined) return;
    try {
      closeSync(this.#fd);
    } catch {}
    this.#fd = undefined;
  }
}

function replaceWrite(stream: NodeJS.WriteStream, write: (text: string) => void): void {
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    write(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    if (callback) process.nextTick(callback);
    return true;
  }) as typeof stream.write;
}

/** The path of a job's new file, after removing any file an earlier attempt left. */
function newJobFile(dir: string, jobId: string): string {
  for (const decided of ['', `.${LogsDecision.EXPORT}`, `.${LogsDecision.PRIVATE}`]) {
    for (const done of ['', '.done']) {
      rmSync(join(dir, `job-${jobId}${decided}${done}.log`), { force: true });
    }
  }
  return join(dir, `job-${jobId}.log`);
}

/** Send this job process's stdout and stderr, and so its log records, to the job's file. */
export function redirectJobOutput(jobId: string, redaction: boolean): JobOutput | undefined {
  const dir = jobsDir();
  if (!logsHandedOff() || dir === undefined) return undefined;
  let path: string;
  let fd: number;
  try {
    path = newJobFile(dir, jobId);
    fd = openSync(path, 'a', 0o644);
  } catch {
    process.stderr.write(
      JSON.stringify({
        level: 40,
        msg: "failed to open the hosted log file, dropping this job's output",
        jobID: jobId,
      }) + '\n',
    );
    replaceWrite(process.stdout, () => {});
    replaceWrite(process.stderr, () => {});
    return undefined;
  }
  const output = new JobOutput(path, jobId, fd, redaction);
  replaceWrite(process.stdout, (text) => output.write('stdout', text));
  replaceWrite(process.stderr, (text) => output.write('stderr', text));
  process.once('exit', () => output.close());
  return output;
}

/** Add `.done` to a job's file after its process exits. */
export function markProcessDone(jobId: string): void {
  const dir = jobsDir();
  if (dir === undefined) return;
  for (const suffix of ['', ...Object.values(LogsDecision).map((d) => `.${d}`)]) {
    const stem = `job-${jobId}${suffix}`;
    try {
      renameSync(join(dir, `${stem}.log`), join(dir, `${stem}.done.log`));
    } catch {}
  }
}
