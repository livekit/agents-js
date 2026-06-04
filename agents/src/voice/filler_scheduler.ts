// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { delay } from '../utils.js';
import type { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes } from './events.js';
import type { AgentStateChangedEvent, UserStateChangedEvent } from './events.js';
import { type SpeechHandle, isSpeechHandle } from './speech_handle.js';

export type FillerSource = string | ((step: number) => SpeechHandle | string | null | undefined);

type DwellResult = 'timeout' | 'reset' | 'aborted';

/** @internal */
export class FillerScheduler<UserData> {
  readonly createdSpeeches: SpeechHandle[] = [];

  private readonly controller = new AbortController();
  private readonly resetDwellCallbacks = new Set<() => void>();
  private readonly runPromise: Promise<void>;

  constructor(
    private readonly source: FillerSource,
    private readonly options: {
      session: AgentSession<UserData>;
      speechHandle: SpeechHandle;
      delay: number;
      interval: number | null;
      maxSteps: number | null;
    },
  ) {
    if (options.delay < 0) {
      throw new Error('delay must be non-negative');
    }
    if (options.interval !== null && options.interval < 0) {
      throw new Error('interval must be non-negative when set');
    }

    this.runPromise = this.run();
    void this.runPromise.catch(() => undefined);
  }

  async close(): Promise<void> {
    if (!this.controller.signal.aborted) {
      this.controller.abort();
    }
    await this.runPromise;
  }

  resetDwell(): void {
    for (const callback of this.resetDwellCallbacks) {
      callback();
    }
  }

  private async run(): Promise<void> {
    const loopPromise = this.loop();
    try {
      await this.options.speechHandle.waitIfNotInterrupted([loopPromise]);
    } finally {
      if (!this.controller.signal.aborted) {
        this.controller.abort();
      }
      await loopPromise.catch(() => undefined);
    }
  }

  private async loop(): Promise<void> {
    const { signal } = this.controller;

    while (!signal.aborted) {
      await this.waitForInactive(signal);
      if (signal.aborted) {
        break;
      }

      const dwellResult = await this.waitForDwell(signal);
      if (dwellResult === 'aborted') {
        break;
      }
      if (dwellResult === 'reset') {
        continue;
      }

      const source = this.source;
      let handle: SpeechHandle | string | null | undefined;
      if (typeof source === 'function') {
        handle = source(this.createdSpeeches.length);
      } else {
        handle = source;
      }

      if (typeof handle === 'string') {
        handle = this.options.session.say(handle);
      }
      if (isSpeechHandle(handle)) {
        this.createdSpeeches.push(handle);
      }

      if (
        this.options.interval === null ||
        (this.options.maxSteps !== null && this.createdSpeeches.length >= this.options.maxSteps)
      ) {
        break;
      }

      await delay(this.options.interval, { signal }).catch((error: unknown) => {
        if (!signal.aborted) {
          throw error;
        }
      });
    }
  }

  private async waitForInactive(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.isInactive()) {
      await this.waitForStateChange(signal);
    }
  }

  private isInactive(): boolean {
    const { session } = this.options;
    return (
      session.userState !== 'speaking' &&
      session.agentState !== 'speaking' &&
      session.agentState !== 'thinking'
    );
  }

  private async waitForStateChange(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }

    const { session } = this.options;

    await new Promise<void>((resolve) => {
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        session.off(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
        session.off(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const onAbort = finish;
      const onAgentStateChanged = (_ev: AgentStateChangedEvent) => finish();
      const onUserStateChanged = (_ev: UserStateChangedEvent) => finish();

      signal.addEventListener('abort', onAbort, { once: true });
      session.on(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
      session.on(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
    });
  }

  private async waitForDwell(signal: AbortSignal): Promise<DwellResult> {
    if (signal.aborted) {
      return 'aborted';
    }

    const { session } = this.options;

    return await new Promise<DwellResult>((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.resetDwellCallbacks.delete(onReset);
        signal.removeEventListener('abort', onAbort);
        session.off(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
        session.off(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
      };
      const finish = (result: DwellResult) => {
        cleanup();
        resolve(result);
      };
      const onReset = () => finish('reset');
      const onAbort = () => finish('aborted');
      const onAgentStateChanged = (ev: AgentStateChangedEvent) => {
        if (ev.newState === 'speaking' || ev.newState === 'thinking') {
          finish('reset');
        }
      };
      const onUserStateChanged = (ev: UserStateChangedEvent) => {
        if (ev.newState === 'speaking') {
          finish('reset');
        }
      };
      const timer = setTimeout(() => finish('timeout'), this.options.delay);

      this.resetDwellCallbacks.add(onReset);
      signal.addEventListener('abort', onAbort, { once: true });
      session.on(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
      session.on(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
    });
  }
}
