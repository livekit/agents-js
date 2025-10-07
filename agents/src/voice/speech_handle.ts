// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatItem } from '../llm/index.js';
import { Event, Future, shortuuid } from '../utils.js';
import type { Task } from '../utils.js';
import { asyncLocalStorage } from './agent.js';

export class SpeechHandle {
  /** Priority for messages that should be played after all other messages in the queue */
  static SPEECH_PRIORITY_LOW = 0;
  /** Every speech generates by the VoiceAgent defaults to this priority. */
  static SPEECH_PRIORITY_NORMAL = 5;
  /** Priority for important messages that should be played before others. */
  static SPEECH_PRIORITY_HIGH = 10;

  private interruptFut = new Future<void>();
  private authorizedEvent = new Event();
  private scheduledFut = new Future<void>();
  private doneFut = new Future<void>();

  private generations: Future<void>[] = [];
  /** @internal */
  _tasks: Task<void>[] = [];
  private _chatItems: ChatItem[] = [];
  private _numSteps = 1;

  private itemAddedCallbacks: Set<(item: ChatItem) => void> = new Set();
  private doneCallbacks: Set<(sh: SpeechHandle) => void> = new Set();

  constructor(
    private _id: string,
    private _allowInterruptions: boolean,
    /** @internal */
    public _stepIndex: number,
    readonly parent?: SpeechHandle,
  ) {
    this.doneFut.await.finally(() => {
      for (const callback of this.doneCallbacks) {
        callback(this);
      }
    });
  }

  static create(options?: {
    allowInterruptions?: boolean;
    stepIndex?: number;
    parent?: SpeechHandle;
  }) {
    const { allowInterruptions = true, stepIndex = 0, parent } = options ?? {};

    return new SpeechHandle(shortuuid('speech_'), allowInterruptions, stepIndex, parent);
  }

  get interrupted(): boolean {
    return this.interruptFut.done;
  }

  get numSteps(): number {
    return this._numSteps;
  }

  get id(): string {
    return this._id;
  }

  get scheduled(): boolean {
    return this.scheduledFut.done;
  }

  get allowInterruptions(): boolean {
    return this._allowInterruptions;
  }

  /**
   * Allow or disallow interruptions on this SpeechHandle.
   *
   * When set to false, the SpeechHandle will no longer accept any incoming
   * interruption requests until re-enabled. If the handle is already
   * interrupted, clearing interruptions is not allowed.
   *
   * @param value - true to allow interruptions, false to disallow
   * @throws Error If attempting to disable interruptions when already interrupted
   */
  set allowInterruptions(value: boolean) {
    if (this.interrupted && !value) {
      throw new Error(
        'Cannot set allow_interruptions to False, the SpeechHandle is already interrupted',
      );
    }
    this._allowInterruptions = value;
  }

  done(): boolean {
    return this.doneFut.done;
  }

  get chatItems(): ChatItem[] {
    return this._chatItems;
  }

  /**
   * Interrupt the current speech generation.
   *
   * @throws Error If this speech handle does not allow interruptions.
   *
   * @returns The same speech handle that was interrupted.
   */
  interrupt(force: boolean = false): SpeechHandle {
    if (!force && !this.allowInterruptions) {
      throw new Error('This generation handle does not allow interruptions');
    }

    this._cancel();
    return this;
  }

  /**
   * Waits for the entire assistant turn to complete playback.
   *
   * This method waits until the assistant has fully finished speaking,
   * including any finalization steps beyond initial response generation.
   * This is appropriate to call when you want to ensure the speech output
   * has entirely played out, including any tool calls and response follow-ups.
   */
  async waitForPlayout(): Promise<void> {
    const store = asyncLocalStorage.getStore();
    if (store && store?.functionCall) {
      throw new Error(
        `Cannot call 'SpeechHandle.waitForPlayout()' from inside the function tool '${store.functionCall.name}'. ` +
          'This creates a circular wait: the speech handle is waiting for the function tool to complete, ' +
          'while the function tool is simultaneously waiting for the speech handle.\n' +
          "To wait for the assistant's spoken response prior to running this tool, use RunContext.wait_for_playout() instead.",
      );
    }
    await this.doneFut.await;
  }

  async waitIfNotInterrupted(aw: Promise<unknown>[]): Promise<void> {
    const allTasksPromise = Promise.all(aw);
    const fs: Promise<unknown>[] = [allTasksPromise, this.interruptFut.await];
    await Promise.race(fs);
  }

  addDoneCallback(callback: (sh: SpeechHandle) => void) {
    this.doneCallbacks.add(callback);
  }

  removeDoneCallback(callback: (sh: SpeechHandle) => void) {
    this.doneCallbacks.delete(callback);
  }

  /** @internal */
  _cancel(): SpeechHandle {
    if (this.done()) {
      return this;
    }

    if (!this.interruptFut.done) {
      this.interruptFut.resolve();
    }

    return this;
  }

  /** @internal */
  _authorizeGeneration(): void {
    const fut = new Future<void>();
    this.generations.push(fut);
    this.authorizedEvent.set();
  }

  /** @internal */
  _clearAuthorization(): void {
    this.authorizedEvent.clear();
  }

  /** @internal */
  async _waitForAuthorization(): Promise<void> {
    await this.authorizedEvent.wait();
  }

  /** @internal */
  async _waitForGeneration(stepIdx: number = -1): Promise<void> {
    if (this.generations.length === 0) {
      throw new Error('cannot use wait_for_generation: no active generation is running.');
    }

    const index = stepIdx === -1 ? this.generations.length - 1 : stepIdx;
    const generation = this.generations[index];
    if (!generation) {
      throw new Error(`Generation at index ${index} not found.`);
    }
    return generation.await;
  }

  /** @internal */
  async _waitForScheduled(): Promise<void> {
    return this.scheduledFut.await;
  }

  /** @internal */
  _markGenerationDone(): void {
    if (this.generations.length === 0) {
      throw new Error('cannot use mark_generation_done: no active generation is running.');
    }

    const lastGeneration = this.generations[this.generations.length - 1];
    if (lastGeneration && !lastGeneration.done) {
      lastGeneration.resolve();
    }
  }

  /** @internal */
  _markDone(): void {
    if (!this.doneFut.done) {
      this.doneFut.resolve();
      if (this.generations.length > 0) {
        this._markGenerationDone(); // preemptive generation could be cancelled before being scheduled
      }
    }
  }

  /** @internal */
  _markScheduled(): void {
    if (!this.scheduledFut.done) {
      this.scheduledFut.resolve();
    }
  }

  /** @internal */
  _addItemAddedCallback(callback: (item: ChatItem) => void): void {
    this.itemAddedCallbacks.add(callback);
  }

  /** @internal */
  _removeItemAddedCallback(callback: (item: ChatItem) => void): void {
    this.itemAddedCallbacks.delete(callback);
  }

  /** @internal */
  _itemAdded(items: ChatItem[]): void {
    for (const item of items) {
      for (const cb of this.itemAddedCallbacks) {
        cb(item);
      }
      this._chatItems.push(item);
    }
  }
}
