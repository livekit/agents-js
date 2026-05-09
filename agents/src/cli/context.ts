// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

let defaultAgentPath: string | undefined;

/** @internal */
export function setDefaultAgentPath(agentPath: string) {
  defaultAgentPath = agentPath;
}

/** @internal */
export function getDefaultAgentPath(): string | undefined {
  return defaultAgentPath;
}

/** @internal */
export function clearDefaultAgentPath() {
  defaultAgentPath = undefined;
}
