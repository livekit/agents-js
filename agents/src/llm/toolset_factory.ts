// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Tool, Toolset } from './tool_context.js';

/** Options accepted by `Toolset.create()` — id + tools plus optional lifecycle hooks. */
export interface ToolsetCreateOptions {
  id: string;
  tools: readonly Tool[];
  /** Invoked when the toolset becomes active in an `AgentActivity`. */
  setup?: () => Promise<void>;
  /** Invoked when the toolset is being torn down. */
  aclose?: () => Promise<void>;
}

// tool_context.ts passes the runtime base class in to avoid a circular runtime import.
type ToolsetCtor = new (options: { id: string; tools: readonly Tool[] }) => Toolset;

/** @internal — backing implementation for `Toolset.create()`. */
export function createToolsetFactory(
  ToolsetBase: ToolsetCtor,
  options: ToolsetCreateOptions,
): Toolset {
  class ToolsetFactory extends ToolsetBase {
    readonly #setupFn?: () => Promise<void>;

    readonly #acloseFn?: () => Promise<void>;

    constructor({ id, tools, setup, aclose }: ToolsetCreateOptions) {
      super({ id, tools });
      this.#setupFn = setup;
      this.#acloseFn = aclose;
    }

    override async setup(): Promise<void> {
      if (this.#setupFn) await this.#setupFn();
    }

    override async aclose(): Promise<void> {
      if (this.#acloseFn) await this.#acloseFn();
    }
  }

  return new ToolsetFactory(options);
}
