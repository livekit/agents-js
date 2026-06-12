// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AgentActivity } from '../voice/agent_activity.js';
import type { AgentSession } from '../voice/agent_session.js';
import { ToolExecutor, type ToolHandlingOptions } from '../voice/tool_executor.js';
import { Toolset, type ToolsetCreateOptions } from './tool_context.js';

export interface AsyncToolsetCreateOptions extends ToolsetCreateOptions {
  toolHandling?: ToolHandlingOptions;
}

export class AsyncToolset extends Toolset {
  readonly _executor = new ToolExecutor({ owningActivity: null });
  private readonly asyncToolOptionsOverride?: ToolHandlingOptions['asyncOptions'];

  private constructor({ id, tools, toolHandling }: AsyncToolsetCreateOptions) {
    super({ id, tools });
    this.asyncToolOptionsOverride = toolHandling?.asyncOptions;
  }

  static override create(options: AsyncToolsetCreateOptions): AsyncToolset {
    return new AsyncToolset(options);
  }

  _attachActivity({
    activity,
    session,
  }: {
    activity: AgentActivity | null;
    session: AgentSession;
  }): void {
    this._executor.setOwningActivity(
      activity as unknown as Parameters<ToolExecutor['setOwningActivity']>[0],
    );
    if (this.asyncToolOptionsOverride) {
      this._executor.setToolOptions(this.asyncToolOptionsOverride);
      return;
    }
    const activityOptions = activity?.agent?._asyncToolOptions;
    if (activityOptions) {
      this._executor.setToolOptions(activityOptions);
      return;
    }
    const sessionOptions = session._asyncToolOptions;
    if (sessionOptions) {
      this._executor.setToolOptions(sessionOptions);
    }
  }

  override async aclose(): Promise<void> {
    await super.aclose();
    await this._executor.drain();
    await this._executor.aclose();
  }
}
