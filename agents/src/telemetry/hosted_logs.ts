// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { closeSync, existsSync, openSync } from 'node:fs';

export const HOSTED_LOGS_ENV = 'LIVEKIT_HOSTED_LOGS';
export const HOSTED_LOGS_ENABLED = 'true';
export const HOSTED_LOGS_HANDOFF_FILE_ENV = 'LIVEKIT_HOSTED_LOGS_HANDOFF_FILE';

function handoffFile(): string | undefined {
  if (process.env[HOSTED_LOGS_ENV] !== HOSTED_LOGS_ENABLED) {
    return undefined;
  }
  return process.env[HOSTED_LOGS_HANDOFF_FILE_ENV] || undefined;
}

export function handOffLogs(): void {
  const path = handoffFile();
  if (path === undefined) {
    return;
  }
  try {
    closeSync(openSync(path, 'a'));
  } catch {}
}

export function logsHandedOff(): boolean {
  const path = handoffFile();
  return path !== undefined && existsSync(path);
}
