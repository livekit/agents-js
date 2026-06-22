// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export {
  TaskGroup,
  type TaskCompletedEvent,
  type TaskGroupOptions,
  type TaskGroupResult,
} from './workflows/index.js';
/**
 * @deprecated `WarmTransferTask` has moved to the stable `workflows` namespace.
 * Import it as `workflows.WarmTransferTask`. This `beta` re-export is a temporary
 * compatibility alias and will be removed in a future release.
 */
export { WarmTransferTask } from './workflows/index.js';
/**
 * @deprecated Import from the stable `workflows` namespace instead (e.g.
 * `workflows.WarmTransferResult`). These `beta` re-exports are temporary
 * compatibility aliases and will be removed in a future release.
 */
export type {
  WarmTransferResult,
  WarmTransferTaskOptions,
  InstructionParts,
} from './workflows/index.js';
export { Instructions } from '../llm/index.js';
export {
  END_CALL_DESCRIPTION,
  createEndCallTool,
  type EndCallToolCalledEvent,
  type EndCallToolCompletedEvent,
  type EndCallToolOptions,
} from './tools/index.js';
