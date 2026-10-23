// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { closeSync, existsSync, openSync } from 'node:fs';
import { log } from '../log.js';

export const HOSTED_LOGS_ENV = 'LIVEKIT_HOSTED_LOGS';
export const HOSTED_LOGS_SIDECAR = 'sidecar';
export const HOSTED_LOGS_HANDOFF_FILE_ENV = 'LIVEKIT_HOSTED_LOGS_HANDOFF_FILE';

function handoffFile(): string | undefined {
  if (process.env[HOSTED_LOGS_ENV] !== HOSTED_LOGS_SIDECAR) {
    return undefined;
  }
  return process.env[HOSTED_LOGS_HANDOFF_FILE_ENV] || undefined;
}

export function logsHandledBySidecar(): boolean {
  const path = handoffFile();
  return path !== undefined && existsSync(path);
}

export function handOffLogsToSidecar(): void {
  const path = handoffFile();
  if (path === undefined) {
    return;
  }
  try {
    closeSync(openSync(path, 'a'));
  } catch (error) {
    log().warn(
      { error, path },
      'could not create the hosted log hand-off file, the SDK keeps exporting logs',
    );
  }
}
