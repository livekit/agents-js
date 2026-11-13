// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { version } from '../version.js';
import {
  HANDED_OFF_ENV,
  HOSTED_LOGS_ENABLED,
  HOSTED_LOGS_ENV,
  HOSTED_LOGS_HANDOFF_FILE_ENV,
  HOSTED_LOGS_JOBS_DIR_ENV,
  JobOutput,
  handOffLogs,
  logsHandedOff,
  markProcessDone,
  redactRecord,
  redirectJobOutput,
} from './hosted_logs.js';

let dir: string;
let jobsDir: string;
let handoffFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hosted-logs-'));
  jobsDir = join(dir, 'jobs');
  handoffFile = join(dir, 'sdk-handoff');
  vi.stubEnv(HOSTED_LOGS_ENV, HOSTED_LOGS_ENABLED);
  vi.stubEnv(HOSTED_LOGS_HANDOFF_FILE_ENV, handoffFile);
  vi.stubEnv(HOSTED_LOGS_JOBS_DIR_ENV, jobsDir);
  vi.stubEnv(HANDED_OFF_ENV, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const jobFiles = () => readdirSync(jobsDir).sort();

function newOutput(redaction = false): JobOutput {
  mkdirSync(jobsDir, { recursive: true });
  const path = join(jobsDir, 'job-AJ_1.log');
  return new JobOutput(path, 'AJ_1', openSync(path, 'a'), redaction);
}

const record = (fields: Record<string, unknown>) => JSON.stringify({ level: 30, ...fields }) + '\n';

describe('hosted log hand-off', () => {
  it('writes the sdk and version, and tells child processes', () => {
    expect(logsHandedOff()).toBe(false);
    handOffLogs();
    expect(JSON.parse(readFileSync(handoffFile, 'utf8'))).toEqual({ sdk: 'node', version });
    expect(existsSync(jobsDir)).toBe(true);
    expect(process.env[HANDED_OFF_ENV]).toBe('1');
    expect(logsHandedOff()).toBe(true);
  });

  it('trusts a hand-off from the parent without writing the file again', () => {
    vi.stubEnv(HANDED_OFF_ENV, '1');
    handOffLogs();
    expect(existsSync(handoffFile)).toBe(false);
    expect(logsHandedOff()).toBe(true);
  });

  it.each([
    [HOSTED_LOGS_ENV, 'something-else'],
    [HOSTED_LOGS_HANDOFF_FILE_ENV, ''],
    [HOSTED_LOGS_JOBS_DIR_ENV, ''],
  ])('does not hand off when %s is %j', (name, value) => {
    vi.stubEnv(name, value);
    handOffLogs();
    expect(existsSync(handoffFile)).toBe(false);
    expect(logsHandedOff()).toBe(false);
  });

  it('keeps exporting when the file cannot be written', () => {
    vi.stubEnv(HOSTED_LOGS_HANDOFF_FILE_ENV, join(dir, 'missing-dir', 'sdk-handoff'));
    handOffLogs();
    expect(logsHandedOff()).toBe(false);
  });
});

describe('job output', () => {
  it('writes raw lines at once and holds records until the decision', () => {
    const out = newOutput();
    out.write('stdout', 'raw before\n');
    out.write('stdout', record({ msg: 'held' }));
    expect(readFileSync(join(jobsDir, 'job-AJ_1.log'), 'utf8')).toBe('raw before\n');
    out.decide({ logs: true, redaction: false });
    out.write('stdout', record({ msg: 'after' }));
    out.close();
    const lines = readFileSync(join(jobsDir, 'job-AJ_1.export.log'), 'utf8').trim().split('\n');
    expect(lines[0]).toBe('raw before');
    expect(lines.slice(1).map((l) => JSON.parse(l).msg)).toEqual(['held', 'after']);
  });

  it.each([
    [true, 'job-AJ_1.export.log'],
    [false, 'job-AJ_1.private.log'],
  ])('names the file from the logs option (logs=%s)', (logs, name) => {
    const out = newOutput();
    out.decide({ logs, redaction: true });
    out.close();
    expect(jobFiles()).toEqual([name]);
  });

  it('keeps the first decision', () => {
    const out = newOutput();
    out.decide({ logs: false, redaction: false });
    out.decide({ logs: true, redaction: false });
    out.close();
    expect(jobFiles()).toEqual(['job-AJ_1.private.log']);
  });

  it('never writes records without a decision', () => {
    const out = newOutput();
    out.write('stdout', record({ msg: 'held' }));
    out.close();
    expect(readFileSync(join(jobsDir, 'job-AJ_1.log'), 'utf8')).toBe('');
  });

  it.each([
    ['the project', true, false],
    ['the session', false, true],
  ])('redacts held and later records when %s requires it', (_source, project, session) => {
    const out = newOutput(project);
    out.write('stdout', record({ msg: 'before', 'lk.pii.secret': 's', room: 'alice' }));
    out.decide({ logs: true, redaction: session });
    out.write(
      'stdout',
      record({ msg: 'after', err: { type: 'Error', message: 'secret', stack: 'x' } }),
    );
    out.close();
    const lines = readFileSync(join(jobsDir, 'job-AJ_1.export.log'), 'utf8').trim().split('\n');
    const [before, after] = lines.map((l) => JSON.parse(l));
    expect(before).toEqual({
      level: 30,
      msg: 'before',
      room: 'alice',
      'lk.redaction.enabled': true,
    });
    expect(after.err).toEqual({ type: 'Error', message: 'exception details redacted' });
    expect(after['lk.redaction.enabled']).toBe(true);
  });

  it('keeps PII fields when redaction is off', () => {
    const out = newOutput();
    out.decide({ logs: true, redaction: false });
    out.write('stdout', record({ msg: 'x', 'lk.pii.secret': 's' }));
    out.close();
    const line = JSON.parse(readFileSync(join(jobsDir, 'job-AJ_1.export.log'), 'utf8'));
    expect(line['lk.pii.secret']).toBe('s');
    expect(line['lk.redaction.enabled']).toBeUndefined();
  });

  it('never tears a line, and writes a partial line at close', () => {
    const out = newOutput();
    out.decide({ logs: true, redaction: false });
    out.write('stdout', 'hel');
    out.write('stderr', 'error line\n');
    out.write('stdout', 'lo\npartial');
    out.close();
    expect(readFileSync(join(jobsDir, 'job-AJ_1.export.log'), 'utf8')).toBe(
      'error line\nhello\npartial\n',
    );
  });

  it('drops the rest of the output when the rename fails', () => {
    const out = newOutput();
    rmSync(jobsDir, { recursive: true });
    out.decide({ logs: true, redaction: false });
    out.write('stdout', 'dropped\n');
    out.close();
    expect(existsSync(jobsDir)).toBe(false);
  });
});

describe('redirectJobOutput', () => {
  it('sends stdout and stderr writes to the job file', () => {
    handOffLogs();
    const write = { out: process.stdout.write, err: process.stderr.write };
    let out: JobOutput | undefined;
    try {
      out = redirectJobOutput('AJ_1', false);
      process.stdout.write('from stdout\n');
      process.stderr.write(Buffer.from('from stderr\n'));
    } finally {
      process.stdout.write = write.out;
      process.stderr.write = write.err;
    }
    out!.decide({ logs: true, redaction: false });
    out!.close();
    expect(readFileSync(join(jobsDir, 'job-AJ_1.export.log'), 'utf8')).toBe(
      'from stdout\nfrom stderr\n',
    );
  });

  it('does nothing without a hand-off', () => {
    expect(redirectJobOutput('AJ_1', false)).toBeUndefined();
  });

  it('gives a retried job a new file', () => {
    handOffLogs();
    const stale = join(jobsDir, 'job-AJ_1.log');
    writeFileSync(stale, 'earlier attempt\n');
    writeFileSync(join(jobsDir, 'job-AJ_1.export.done.log'), 'older attempt\n');
    const oldInode = statSync(stale).ino;
    const write = { out: process.stdout.write, err: process.stderr.write };
    let out: JobOutput | undefined;
    try {
      out = redirectJobOutput('AJ_1', false);
    } finally {
      process.stdout.write = write.out;
      process.stderr.write = write.err;
    }
    expect(jobFiles()).toEqual(['job-AJ_1.log']);
    expect(readFileSync(stale, 'utf8')).toBe('');
    expect(statSync(stale).ino).not.toBe(oldInode);
    out!.close();
  });
});

describe('markProcessDone', () => {
  it.each(['job-AJ_1.log', 'job-AJ_1.export.log', 'job-AJ_1.private.log'])(
    'adds .done to %s',
    (name) => {
      mkdirSync(jobsDir);
      openSync(join(jobsDir, name), 'a');
      markProcessDone('AJ_1');
      expect(jobFiles()).toEqual([name.replace(/\.log$/, '.done.log')]);
    },
  );
});

describe('redactRecord', () => {
  it('leaves the original record unchanged', () => {
    const original = { msg: 'x', 'lk.pii.secret': 's' };
    redactRecord(original);
    expect(original['lk.pii.secret']).toBe('s');
  });
});
