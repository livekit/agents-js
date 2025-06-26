// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatMessage } from '../llm/index.js';
import { shortuuid } from '../llm/misc.js';
import { Future } from '../utils.js';

export class SpeechHandle {
  /** Priority for messages that should be played after all other messages in the queue */
  static SPEECH_PRIORITY_LOW = 0;
  /** Every speech generates by the VoiceAgent defaults to this priority. */
  static SPEECH_PRIORITY_NORMAL = 5;
  /** Priority for important messages that should be played before others. */
  static SPEECH_PRIORITY_HIGH = 10;

  private interruptFut = new Future();
  private authorizeFut = new Future();
  private playoutDoneFut = new Future();

  private _chatMessage?: ChatMessage;

  constructor(
    readonly id: string,
    readonly allowInterruptions: boolean,
    readonly stepIndex: number,
    readonly parent?: SpeechHandle,
  ) {}

  static create(options: {
    allowInterruptions?: boolean;
    stepIndex?: number;
    parent?: SpeechHandle;
  }) {
    const { allowInterruptions = false, stepIndex = 0, parent } = options ?? {};

    return new SpeechHandle(shortuuid('speech'), allowInterruptions, stepIndex, parent);
  }

  get interrupted(): boolean {
    return this.interruptFut.done;
  }

  get done(): boolean {
    return this.playoutDoneFut.done;
  }

  get chatMessage(): ChatMessage | undefined {
    return this._chatMessage;
  }

  /**
   * Interrupt the current speech generation.
   *
   * @throws Error If this speech handle does not allow interruptions.
   *
   * @returns The same speech handle that was interrupted.
   */
  interrupt(): SpeechHandle {
    if (!this.allowInterruptions) {
      throw new Error('interruptions are not allowed');
    }
    this.interruptFut.resolve();
    return this;
  }

  async waitForPlayout() {
    return this.playoutDoneFut.await;
  }

  async waitIfNotInterrupted(aw: Promise<unknown>[]): Promise<void> {
    const allTasksPromise = Promise.all(aw);
    const fs: Promise<unknown>[] = [allTasksPromise, this.interruptFut.await];
    await Promise.race(fs);
  }

  /** @internal */
  _setChatMessage(chatMessage: ChatMessage) {
    if (this.done) {
      throw new Error('cannot set chat message after speech has been played');
    }
    this._chatMessage = chatMessage;
  }

  /** @internal */
  _authorizePlayout() {
    this.authorizeFut.resolve();
  }

  /** @internal */
  async _waitForAuthorization() {
    return this.authorizeFut.await;
  }

  /** @internal */
  _markPlayoutDone() {
    this.playoutDoneFut.resolve();
  }
}
