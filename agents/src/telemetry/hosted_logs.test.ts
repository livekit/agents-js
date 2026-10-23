// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import {
  HOSTED_LOGS_ENV,
  HOSTED_LOGS_HANDOFF_FILE_ENV,
  HOSTED_LOGS_SIDECAR,
  handOffLogsToSidecar,
  logsHandledBySidecar,
} from './hosted_logs.js';

describe('hosted log sidecar hand-off', () => {
  let dir: string;
  let handoffFile: string;

  beforeAll(() => {
    initializeLogger({ pretty: false, level: 'silent' });
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hosted-logs-'));
    handoffFile = join(dir, 'sdk-handoff');
    vi.stubEnv(HOSTED_LOGS_ENV, HOSTED_LOGS_SIDECAR);
    vi.stubEnv(HOSTED_LOGS_HANDOFF_FILE_ENV, handoffFile);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file', () => {
    expect(logsHandledBySidecar()).toBe(false);
    handOffLogsToSidecar();
    expect(existsSync(handoffFile)).toBe(true);
    expect(logsHandledBySidecar()).toBe(true);
  });

  it('keeps an existing file', () => {
    writeFileSync(handoffFile, 'x');
    handOffLogsToSidecar();
    expect(readFileSync(handoffFile, 'utf8')).toBe('x');
    expect(logsHandledBySidecar()).toBe(true);
  });

  it('does not hand off without sidecar mode', () => {
    vi.stubEnv(HOSTED_LOGS_ENV, 'something-else');
    handOffLogsToSidecar();
    expect(existsSync(handoffFile)).toBe(false);
    expect(logsHandledBySidecar()).toBe(false);
  });

  it('does not hand off without a file path', () => {
    vi.stubEnv(HOSTED_LOGS_HANDOFF_FILE_ENV, '');
    handOffLogsToSidecar();
    expect(logsHandledBySidecar()).toBe(false);
  });

  it('keeps exporting when the file cannot be created', () => {
    vi.stubEnv(HOSTED_LOGS_HANDOFF_FILE_ENV, join(dir, 'missing-dir', 'sdk-handoff'));
    handOffLogsToSidecar();
    expect(logsHandledBySidecar()).toBe(false);
  });
});
