// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

const defaultAgentPathKey = Symbol.for('@livekit/agents.cli.defaultAgentPath');
const globalAgentContext = globalThis as typeof globalThis & {
  [key: symbol]: string | undefined;
};

/** @internal */
export function setDefaultAgentPath(agentPath: string) {
  globalAgentContext[defaultAgentPathKey] = agentPath;
}

/** @internal */
export function getDefaultAgentPath(): string | undefined {
  return globalAgentContext[defaultAgentPathKey];
}

/** @internal */
export function clearDefaultAgentPath() {
  delete globalAgentContext[defaultAgentPathKey];
}
