// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { voice } from '@livekit/agents';
import { log } from '../log.js';
import { deserializeChat } from './codec.js';

const DEFAULT_BOT_NAME = 'LemonSlice Avatar';

export function formatChatUserInput({ sender, text }: { sender: string; text: string }): string {
  return `[${sender}]: ${text}`;
}

export class MeetingChatRelay {
  private session: voice.AgentSession;
  private botName: string;
  private queue: string[] = [];
  private drainTask?: Promise<void>;
  private notifyDrain?: () => void;
  private closing = false;

  #logger = log();

  constructor(session: voice.AgentSession, { botName }: { botName?: string | null } = {}) {
    this.session = session;
    this.botName = (botName?.trim() || DEFAULT_BOT_NAME).toLowerCase();
  }

  submitJson(payload: string): void {
    const message = deserializeChat(payload);
    if (!message || message.sender.trim().toLowerCase() === this.botName) {
      return;
    }

    if (this.queue.length >= 100) {
      this.#logger.warn('meeting chat relay queue full; dropping message');
      return;
    }

    this.queue.push(formatChatUserInput({ sender: message.sender, text: message.text }));
    this.notifyDrain?.();
  }

  start(): void {
    if (!this.drainTask) {
      this.drainTask = this.drain();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.notifyDrain?.();
    await this.drainTask;
    this.drainTask = undefined;
  }

  private async drain(): Promise<void> {
    while (!this.closing) {
      const userInput = this.queue.shift() ?? (await this.nextMessage());
      if (!userInput) {
        continue;
      }

      await this.waitForSessionStarted();
      try {
        await this.session.interrupt().await;
        this.session.generateReply({ userInput });
      } catch (error) {
        this.#logger.warn({ error }, 'meeting chat relay: generateReply failed');
      }
    }
  }

  private async nextMessage(): Promise<string | undefined> {
    if (this.queue.length > 0) {
      return this.queue.shift();
    }
    await new Promise<void>((resolve) => {
      this.notifyDrain = resolve;
    });
    this.notifyDrain = undefined;
    return this.queue.shift();
  }

  private async waitForSessionStarted(): Promise<void> {
    while (!this.closing && this.session.agentState === 'initializing') {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
