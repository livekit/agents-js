// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOSTED_LOGS_ENABLED,
  HOSTED_LOGS_ENV,
  HOSTED_LOGS_HANDOFF_FILE_ENV,
  handOffLogs,
  logsHandedOff,
} from './hosted_logs.js';

describe('hosted log hand-off', () => {
  let dir: string;
  let handoffFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hosted-logs-'));
    handoffFile = join(dir, 'sdk-handoff');
    vi.stubEnv(HOSTED_LOGS_ENV, HOSTED_LOGS_ENABLED);
    vi.stubEnv(HOSTED_LOGS_HANDOFF_FILE_ENV, handoffFile);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file', () => {
    expect(logsHandedOff()).toBe(false);
    handOffLogs();
    expect(existsSync(handoffFile)).toBe(true);
    expect(logsHandedOff()).toBe(true);
  });

  it('keeps an existing file', () => {
    writeFileSync(handoffFile, 'x');
    handOffLogs();
    expect(readFileSync(handoffFile, 'utf8')).toBe('x');
    expect(logsHandedOff()).toBe(true);
  });

  it('does not hand off when hosted logs are off', () => {
    vi.stubEnv(HOSTED_LOGS_ENV, 'something-else');
    handOffLogs();
    expect(existsSync(handoffFile)).toBe(false);
    expect(logsHandedOff()).toBe(false);
  });

  it('does not hand off without a file path', () => {
    vi.stubEnv(HOSTED_LOGS_HANDOFF_FILE_ENV, '');
    handOffLogs();
    expect(logsHandedOff()).toBe(false);
  });

  it('keeps exporting when the file cannot be created', () => {
    vi.stubEnv(HOSTED_LOGS_HANDOFF_FILE_ENV, join(dir, 'missing-dir', 'sdk-handoff'));
    handOffLogs();
    expect(logsHandedOff()).toBe(false);
  });
});
