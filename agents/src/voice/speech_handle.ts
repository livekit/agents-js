// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'crypto';
import type { ChatMessage, LLMStream } from '../llm/index.js';
import { AsyncIterableQueue, Future } from '../utils.js';

// TODO(AJS-50): Update speech handle to 1.0
export class SpeechHandle {
  /** Priority for messages that should be played after all other messages in the queue */
  static SPEECH_PRIORITY_LOW = 0;
  /** Every speech generates by the VoiceAgent defaults to this priority. */
  static SPEECH_PRIORITY_NORMAL = 5;
  /** Priority for important messages that should be played before others. */
  static SPEECH_PRIORITY_HIGH = 10;

  #id: string;
  #allowInterruptions: boolean;
  #addToChatCtx: boolean;
  #isReply: boolean;
  #userQuestion: string;
  #userCommitted = false;
  #initFut = new Future();
  private interruptFut = new Future();
  private authorizeFut = new Future();
  private playoutDoneFut = new Future();
  #speechCommitted = false;
  #source?: string | LLMStream | AsyncIterable<string>;
  #initialized = false;
  #fncNestedDepth: number;
  #fncExtraToolsMesages?: ChatMessage[];
  #nestedSpeechHandles: SpeechHandle[] = [];
  #nestedSpeechChanged = new AsyncIterableQueue<void>();
  #nestedSpeechFinished = false;
  private parent?: SpeechHandle;

  constructor(
    id: string,
    allowInterruptions: boolean,
    addToChatCtx: boolean,
    isReply: boolean,
    userQuestion: string,
    fncNestedDepth = 0,
    extraToolsMessages: ChatMessage[] | undefined = undefined,
    parent?: SpeechHandle,
  ) {
    this.#id = id;
    this.#allowInterruptions = allowInterruptions;
    this.#addToChatCtx = addToChatCtx;
    this.#isReply = isReply;
    this.#userQuestion = userQuestion;
    this.#fncNestedDepth = fncNestedDepth;
    this.#fncExtraToolsMesages = extraToolsMessages;
    this.parent = parent;
  }

  static create(allowInterruptions: boolean = false, stepIndex: number = 0, parent?: SpeechHandle) {
    return new SpeechHandle(
      randomUUID(),
      allowInterruptions,
      false,
      false,
      '',
      stepIndex,
      undefined,
      parent,
    );
  }

  /** @deprecated Use SpeechHandle.create instead */
  static createAssistantReply(
    allowInterruptions: boolean,
    addToChatCtx: boolean,
    userQuestion: string,
  ): SpeechHandle {
    return new SpeechHandle(randomUUID(), allowInterruptions, addToChatCtx, true, userQuestion);
  }

  /** @deprecated Use SpeechHandle.create instead */
  static createAssistantSpeech(allowInterruptions: boolean, addToChatCtx: boolean): SpeechHandle {
    return new SpeechHandle(randomUUID(), allowInterruptions, addToChatCtx, false, '');
  }

  /** @deprecated Use SpeechHandle.create instead */
  static createToolSpeech(
    allowInterruptions: boolean,
    addToChatCtx: boolean,
    fncNestedDepth: number,
    extraToolsMessages: ChatMessage[],
  ): SpeechHandle {
    return new SpeechHandle(
      randomUUID(),
      allowInterruptions,
      addToChatCtx,
      false,
      '',
      fncNestedDepth,
      extraToolsMessages,
    );
  }

  async waitForInitialization() {
    await this.#initFut.await;
  }

  initialize(source: string | LLMStream | AsyncIterable<string>) {
    this.#source = source;
    this.#initialized = true;
    this.#initFut.resolve();
  }

  markUserCommitted() {
    this.#userCommitted = true;
  }

  markSpeechCommitted() {
    this.#speechCommitted = true;
  }

  get userCommitted(): boolean {
    return this.#userCommitted;
  }

  get speechCommitted(): boolean {
    return this.#speechCommitted;
  }

  get id(): string {
    return this.#id;
  }

  get allowInterruptions(): boolean {
    return this.#allowInterruptions;
  }

  get addToChatCtx(): boolean {
    return this.#addToChatCtx;
  }

  get source(): string | LLMStream | AsyncIterable<string> {
    if (!this.#source) {
      throw new Error('speech not initialized');
    }
    return this.#source;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  get isReply(): boolean {
    return this.#isReply;
  }

  get userQuestion(): string {
    return this.#userQuestion;
  }

  get interrupted(): boolean {
    return this.interruptFut.done;
  }

  get fncNestedDepth(): number {
    return this.#fncNestedDepth;
  }

  get extraToolsMessages(): ChatMessage[] | undefined {
    return this.#fncExtraToolsMesages;
  }

  addNestedSpeech(handle: SpeechHandle) {
    this.#nestedSpeechHandles.push(handle);
    this.#nestedSpeechChanged.put();
  }

  get nestedSpeechHandles(): SpeechHandle[] {
    return this.#nestedSpeechHandles;
  }

  async nestedSpeechChanged() {
    await this.#nestedSpeechChanged.next();
  }

  get nestedSpeechFinished(): boolean {
    return this.#nestedSpeechFinished;
  }

  markNestedSpeechFinished() {
    this.#nestedSpeechFinished = true;
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

  async waitIfNotInterrupted(aw: Promise<void>[]): Promise<void> {
    const fs: Promise<void>[] = [...aw, this.interruptFut.await];
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
    this.cancel();
  }

  interrupt(): SpeechHandle {
    if (!this.#allowInterruptions) {
      throw new Error('interruptions are not allowed');
    }
    this.interruptFut.resolve();
    return this;
  }

  cancel() {
    this.#initFut.reject(new Error());
    this.#nestedSpeechChanged.close();
  }
}
