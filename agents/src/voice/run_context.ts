// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { FunctionCall } from '../llm/chat_context.js';
import type { AgentSession } from './agent_session.js';
import { FillerScheduler, type FillerSource } from './filler_scheduler.js';
import type { SpeechHandle } from './speech_handle.js';

export type { FillerSource } from './filler_scheduler.js';

export type UnknownUserData = unknown;

export class RunContext<UserData = UnknownUserData> {
  private readonly initialStepIdx: number;
  private readonly fillerSchedulers: FillerScheduler<UserData>[] = [];

  constructor(
    public readonly session: AgentSession<UserData>,
    public readonly speechHandle: SpeechHandle,
    public readonly functionCall: FunctionCall,
  ) {
    this.initialStepIdx = speechHandle.numSteps - 1;
  }
  get userData(): UserData {
    return this.session.userData;
  }

  /**
   * Waits for the speech playout corresponding to this function call step.
   *
   * Unlike {@link SpeechHandle.waitForPlayout}, which waits for the full
   * assistant turn to complete (including all function tools),
   * this method only waits for the assistant's spoken response prior to running
   * this tool to finish playing.
   */
  async waitForPlayout() {
    return this.speechHandle._waitForGeneration(this.initialStepIdx);
  }

  /**
   * Schedule filler speech while a long-running tool step is active.
   *
   * While `fn` is running, a background scheduler waits for the session to be continuously
   * idle for `delay` milliseconds, then plays `source`. With `interval` set, it waits that
   * many milliseconds before restarting the dwell wait. `interval: null` fires at most once.
   *
   * `source` can be a string spoken with {@link AgentSession.say}, or a callback invoked at
   * fire time with the number of filler speeches already created. Returning `null` or
   * `undefined` skips that fire and retries on the next interval.
   */
  async withFiller<T>(
    source: FillerSource,
    fn: () => T | Promise<T>,
    options: { delay?: number; interval?: number | null; maxSteps?: number | null } = {},
  ): Promise<T> {
    const scheduler = new FillerScheduler(source, {
      session: this.session,
      speechHandle: this.speechHandle,
      delay: options.delay ?? 0,
      interval: options.interval ?? null,
      maxSteps: options.maxSteps ?? null,
    });

    this.fillerSchedulers.push(scheduler);
    try {
      return await fn();
    } finally {
      await scheduler.close();
      const index = this.fillerSchedulers.indexOf(scheduler);
      if (index !== -1) {
        this.fillerSchedulers.splice(index, 1);
      }
    }
  }

  /** @internal */
  _resetFillerDwell(): void {
    for (const scheduler of this.fillerSchedulers) {
      scheduler.resetDwell();
    }
  }
}
