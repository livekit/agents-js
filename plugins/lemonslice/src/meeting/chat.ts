// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { voice } from '@livekit/agents';
import { log } from '../log.js';
import { deserializeChat } from './codec.js';

const DEFAULT_BOT_NAME = 'LemonSlice Avatar';

/** Format a meeting chat message as agent user input. */
export function formatChatUserInput({ sender, text }: { sender: string; text: string }): string {
  return `[${sender}]: ${text}`;
}

/** Relay external meeting chat messages into an AgentSession. */
export class MeetingChatRelay {
  private readonly session: voice.AgentSession;
  private readonly botName: string;
  private readonly queue: string[] = [];
  private readonly maxQueueSize = 100;
  private drainAbort?: AbortController;
  private drainPromise?: Promise<void>;
  private wakeDrain?: () => void;
  private closed = false;

  #logger = log();

  constructor(session: voice.AgentSession, { botName }: { botName?: string | null } = {}) {
    this.session = session;
    const name = botName?.trim();
    this.botName = (name || DEFAULT_BOT_NAME).toLowerCase();
  }

  /** Queue a raw chat JSON payload from the meeting relay WebSocket. */
  submitJson(payload: string): void {
    if (this.closed) {
      return;
    }

    const message = deserializeChat(payload);
    if (message === null) {
      return;
    }
    if (message.sender.trim().toLowerCase() === this.botName) {
      return;
    }

    const userInput = formatChatUserInput({ sender: message.sender, text: message.text });
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.#logger.warn('meeting chat relay queue full; dropping message');
    }
    this.queue.push(userInput);
    this.wakeDrain?.();
  }

  /** Start draining queued chat messages into the agent session. */
  start(): void {
    if (this.drainPromise !== undefined) {
      return;
    }

    const abortController = new AbortController();
    this.drainAbort = abortController;
    this.drainPromise = this.drain(abortController.signal);
  }

  async aclose(): Promise<void> {
    this.closed = true;
    this.drainAbort?.abort();
    this.wakeDrain?.();
    if (this.drainPromise !== undefined) {
      await this.drainPromise;
      this.drainPromise = undefined;
    }
    this.drainAbort = undefined;
  }

  private async drain(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.closed) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          if (signal.aborted || this.closed) {
            resolve();
            return;
          }
          this.wakeDrain = resolve;
        });
        this.wakeDrain = undefined;
        continue;
      }

      const userInput = this.queue.shift();
      if (userInput === undefined) {
        continue;
      }

      await this.waitForSessionStarted(signal);
      if (signal.aborted || this.closed) {
        return;
      }

      this.#logger.info(
        { 'lk.pii.user_input': userInput.slice(0, 120) },
        'meeting chat relay received user input',
      );
      try {
        this.session.interrupt();
        this.session.generateReply({ userInput });
      } catch (error) {
        this.#logger.warn({ 'lk.pii.error': error }, 'meeting chat relay: generateReply failed');
      }
    }
  }

  private async waitForSessionStarted(signal: AbortSignal): Promise<void> {
    while (this.session.agentState === 'initializing' && !signal.aborted && !this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
