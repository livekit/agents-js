// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'crypto';
import type { ChatMessage, LLMStream } from '../llm/index.js';
import { AsyncIterableQueue, Future } from '../utils.js';
import type { SynthesisHandle } from './agent_output.js';

export class SpeechHandle {
  #id: string;
  #allowInterruptions: boolean;
  #addToChatCtx: boolean;
  #isReply: boolean;
  #userQuestion: string;
  #userCommitted = false;
  #initFut = new Future();
  #doneFut = new Future();
  #speechCommitted = false;
  #source?: string | LLMStream | AsyncIterable<string>;
  #synthesisHandle?: SynthesisHandle;
  #initialized = false;
  #fncNestedDepth: number;
  #fncExtraToolsMesages?: ChatMessage[];
  #nestedSpeechHandles: SpeechHandle[] = [];
  #nestedSpeechChanged = new AsyncIterableQueue<void>();
  #nestedSpeechFinished = false;

  constructor(
    id: string,
    allowInterruptions: boolean,
    addToChatCtx: boolean,
    isReply: boolean,
    userQuestion: string,
    fncNestedDepth = 0,
    extraToolsMessages: ChatMessage[] | undefined = undefined,
  ) {
    this.#id = id;
    this.#allowInterruptions = allowInterruptions;
    this.#addToChatCtx = addToChatCtx;
    this.#isReply = isReply;
    this.#userQuestion = userQuestion;
    this.#fncNestedDepth = fncNestedDepth;
    this.#fncExtraToolsMesages = extraToolsMessages;
  }

  static createAssistantReply(
    allowInterruptions: boolean,
    addToChatCtx: boolean,
    userQuestion: string,
  ): SpeechHandle {
    return new SpeechHandle(randomUUID(), allowInterruptions, addToChatCtx, true, userQuestion);
  }

  static createAssistantSpeech(allowInterruptions: boolean, addToChatCtx: boolean): SpeechHandle {
    return new SpeechHandle(randomUUID(), allowInterruptions, addToChatCtx, false, '');
  }

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

  initialize(source: string | LLMStream | AsyncIterable<string>, synthesisHandle: SynthesisHandle) {
    if (this.interrupted) {
      throw new Error('speech was interrupted');
    }

    this.#source = source;
    this.#synthesisHandle = synthesisHandle;
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

  get synthesisHandle(): SynthesisHandle {
    if (!this.#synthesisHandle) {
      throw new Error('speech not initialized');
    }
    return this.#synthesisHandle;
  }

  set synthesisHandle(handle: SynthesisHandle) {
    this.#synthesisHandle = handle;
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
    return !!this.#synthesisHandle?.interrupted;
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

  join() {
    return this.#doneFut.await;
  }

  setDone() {
    this.#doneFut.resolve();
  }

  interrupt() {
    if (!this.#allowInterruptions) {
      throw new Error('interruptions are not allowed');
    }
    this.cancel();
  }

  cancel() {
    this.#initFut.reject(new Error());
    this.#nestedSpeechChanged.close();
    this.#synthesisHandle?.interrupt();
  }
}
