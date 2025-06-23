// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatMessage } from '../llm/index.js';
import { shortuuid } from '../llm/misc.js';
import { Future } from '../utils.js';

// TODO(AJS-50): Update speech handle to 1.0
export class SpeechHandle {
  /** Priority for messages that should be played after all other messages in the queue */
  static SPEECH_PRIORITY_LOW = 0;
  /** Every speech generates by the VoiceAgent defaults to this priority. */
  static SPEECH_PRIORITY_NORMAL = 5;
  /** Priority for important messages that should be played before others. */
  static SPEECH_PRIORITY_HIGH = 10;

  #id: string;
  #stepIndex: number;
  #allowInterruptions: boolean;
  #parent?: SpeechHandle;

  private interruptFut = new Future();
  private authorizeFut = new Future();
  private playoutDoneFut = new Future();

  #chatMessage?: ChatMessage;

  constructor(id: string, allowInterruptions: boolean, stepIndex: number, parent?: SpeechHandle) {
    this.#id = id;
    this.#allowInterruptions = allowInterruptions;
    this.#stepIndex = stepIndex;
    this.#parent = parent;
  }

  static create(allowInterruptions: boolean = false, stepIndex: number = 0, parent?: SpeechHandle) {
    return new SpeechHandle(shortuuid('speech'), allowInterruptions, stepIndex, parent);
  }

  get id(): string {
    return this.#id;
  }

  get allowInterruptions(): boolean {
    return this.#allowInterruptions;
  }

  get stepIndex(): number {
    return this.#stepIndex;
  }

  get chatMessage(): ChatMessage | undefined {
    return this.#chatMessage;
  }

  get interrupted(): boolean {
    return this.interruptFut.done;
  }

  get parent(): SpeechHandle | undefined {
    return this.#parent;
  }

  authorizePlayout() {
    this.authorizeFut.resolve();
  }

  async waitForAuthorization() {
    return this.authorizeFut.await;
  }

  async waitForPlayout() {
    return this.playoutDoneFut.await;
  }

  async waitIfNotInterrupted(aw: Promise<unknown>[]): Promise<void> {
    const fs: Promise<unknown>[] = [...aw, this.interruptFut.await];
    await Promise.race(fs);
  }

  markPlayoutDone() {
    this.playoutDoneFut.resolve();
  }

  get done(): boolean {
    return this.playoutDoneFut.done;
  }

  /** @deprecated Use interrupt instead */
  legacyInterrupt() {
    if (!this.#allowInterruptions) {
      throw new Error('interruptions are not allowed');
    }
  }

  interrupt(): SpeechHandle {
    if (!this.#allowInterruptions) {
      throw new Error('interruptions are not allowed');
    }
    this.interruptFut.resolve();
    return this;
  }

  setChatMessage(chatMessage: ChatMessage) {
    if (this.done) {
      throw new Error('cannot set chat message after speech has been played');
    }
    this.#chatMessage = chatMessage;
  }
}
