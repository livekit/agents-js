// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-unused-vars */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AudioFrame } from '@livekit/rtc-node';
import type { ChatChunk, ChatMessage, LLM } from '../llm/index.js';
import { ChatContext } from '../llm/index.js';
import type { STT, SpeechEvent } from '../stt/index.js';
import type { TTS } from '../tts/index.js';
import type { VAD } from '../vad.js';

export class Agent {
  private instructions: string;
  private chatCtx: ChatContext;
  private tools: any; // TODO(shubhra): add type
  private turnDetection: any; // TODO(shubhra): add type
  private stt: STT | undefined;
  private vad: VAD | undefined;
  private llm: LLM | any;
  private tts: TTS | undefined;
  private agentActivity: any; // TODO(shubhra): add type

  constructor(
    instructions: string,
    chatCtx?: ChatContext,
    tools?: any, // TODO(shubhra): add type
    turnDetection?: any, // TODO(shubhra): add type
    stt?: STT,
    vad?: VAD,
    llm?: LLM | any,
    tts?: TTS,
    allowInterruptions?: boolean,
  ) {
    this.instructions = instructions;
    this.chatCtx = chatCtx || new ChatContext();
    this.tools = tools;
    this.turnDetection = turnDetection;
    this.stt = stt;
    this.vad = vad;
    this.llm = llm;
    this.tts = tts;
    this.agentActivity = undefined; // TODO(shubhra): add type
  }

  async onEnter(): Promise<void> {}

  async onExit(): Promise<void> {}

  async transcriptionNode(
    text: ReadableStream<string>,
    modelSettings: any, // TODO(shubhra): add type
  ): Promise<ReadableStream<string> | null> {
    return null;
  }

  async onUserTurnCompleted(chatCtx: ChatContext, newMessage: ChatMessage): Promise<void> {}

  async sttNode(
    audio: ReadableStream<AudioFrame>,
    modelSettings: any, // TODO(shubhra): add type
  ): Promise<ReadableStream<SpeechEvent | string> | null> {
    return null;
  }

  async llmNode(
    chatCtx: ChatContext,
    tools: Array<any>, // TODO(shubhra): add type
    modelSettings: any, // TODO(shubhra): add type
  ): Promise<ReadableStream<ChatChunk | string> | null> {
    return null;
  }

  async ttsNode(
    text: ReadableStream<string>,
    modelSettings: any, // TODO(shubhra): add type
  ): Promise<ReadableStream<AudioFrame> | null> {
    return null;
  }

  // realtime_audio_output_node

  static default = {
    async sttNode(
      audio: ReadableStream<AudioFrame>,
      modelSettings: any, // TODO(shubhra): add type
    ): Promise<ReadableStream<SpeechEvent | string> | null> {
      return null;
    },
  };
}
