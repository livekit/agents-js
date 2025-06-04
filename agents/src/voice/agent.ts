// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-unused-vars */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import type { ChatChunk, ChatMessage, LLM } from '../llm/index.js';
import { ChatContext } from '../llm/index.js';
import { StreamAdapter as STTStreamAdapter } from '../stt/index.js';
import type { STT, SpeechEvent } from '../stt/index.js';
import { SentenceTokenizer as BasicSentenceTokenizer } from '../tokenize/basic/index.js';
import type { TTS } from '../tts/index.js';
import { SynthesizeStream, StreamAdapter as TTSStreamAdapter } from '../tts/index.js';
import type { VAD } from '../vad.js';
import type { AgentActivity } from './agent_activity.js';

export class StopResponse extends Error {
  constructor() {
    super();
    this.name = 'StopResponse';
  }
}

export class Agent {
  private _instructions: string;
  private tools: any; // TODO(shubhra): add type
  private turnDetection: any; // TODO(shubhra): add type
  private stt: STT | undefined;
  private vad: VAD | undefined;
  private llm: LLM | any;
  private tts: TTS | undefined;

  /** @internal */
  agentActivity?: AgentActivity;
  /** @internal */
  _chatCtx: ChatContext;

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
    this._instructions = instructions;
    // TODO(AJS-42): copy tools when provided
    this._chatCtx = chatCtx || new ChatContext();
    this.tools = tools;
    this.turnDetection = turnDetection;
    this.stt = stt;
    this.vad = vad;
    this.llm = llm;
    this.tts = tts;
    this.agentActivity = undefined; // TODO(shubhra): add type
  }

  get chatCtx(): ChatContext {
    return this._chatCtx;
  }

  get instructions(): string {
    return this._instructions;
  }

  async onEnter(): Promise<void> {}

  async onExit(): Promise<void> {}

  async transcriptionNode(
    text: ReadableStream<string>,
    modelSettings: any, // TODO(shubhra): add type
  ): Promise<ReadableStream<string> | null> {
    return Agent.default.transcriptionNode(this, text, modelSettings);
  }

  async onUserTurnCompleted(chatCtx: ChatContext, newMessage: ChatMessage): Promise<void> {}

  async sttNode(
    audio: ReadableStream<AudioFrame>,
    modelSettings: any, // TODO(AJS-59): add type
  ): Promise<ReadableStream<SpeechEvent | string> | null> {
    return Agent.default.sttNode(this, audio, modelSettings);
  }

  async llmNode(
    chatCtx: ChatContext,
    modelSettings: any, // TODO(AJS-59): add type
  ): Promise<ReadableStream<ChatChunk | string> | null> {
    return Agent.default.llmNode(this, chatCtx, modelSettings);
  }

  async ttsNode(
    text: ReadableStream<string>,
    modelSettings: any, // TODO(AJS-59): add type
  ): Promise<ReadableStream<AudioFrame> | null> {
    return Agent.default.ttsNode(this, text, modelSettings);
  }

  // realtime_audio_output_node

  getActivityOrThrow(): AgentActivity {
    if (!this.agentActivity) {
      throw new Error('Agent activity not found');
    }
    return this.agentActivity;
  }

  static default = {
    async sttNode(
      agent: Agent,
      audio: ReadableStream<AudioFrame>,
      modelSettings: any, // TODO(AJS-59): add type
    ): Promise<ReadableStream<SpeechEvent | string> | null> {
      const activity = agent.getActivityOrThrow();

      let wrapped_stt = activity.stt;

      if (!wrapped_stt.capabilities.streaming) {
        if (!agent.vad) {
          throw new Error(
            'STT does not support streaming, add a VAD to the AgentTask/VoiceAgent to enable streaming',
          );
        }
        wrapped_stt = new STTStreamAdapter(wrapped_stt, agent.vad);
      }

      const stream = wrapped_stt.stream();
      stream.updateInputStream(audio);

      return new ReadableStream({
        async start(controller) {
          try {
            for await (const event of stream) {
              controller.enqueue(event);
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
        cancel() {
          // Properly close the underlying STT stream when cancelled
          stream.close();
        },
      });
    },

    async llmNode(
      agent: Agent,
      chatCtx: ChatContext,
      modelSettings: any, // TODO(AJS-59): add type
    ): Promise<ReadableStream<ChatChunk | string> | null> {
      const activity = agent.getActivityOrThrow();
      const stream = activity.llm.chat({ chatCtx });
      return new ReadableStream({
        async start(controller) {
          for await (const chunk of stream) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
        cancel() {
          stream.close();
        },
      });
    },

    async ttsNode(
      agent: Agent,
      text: ReadableStream<string>,
      modelSettings: any, // TODO(AJS-59): add type
    ): Promise<ReadableStream<AudioFrame> | null> {
      const activity = agent.getActivityOrThrow();
      let wrapped_tts = activity.tts;

      if (!activity.tts.capabilities.streaming) {
        wrapped_tts = new TTSStreamAdapter(wrapped_tts, new BasicSentenceTokenizer());
      }

      const stream = wrapped_tts.stream();
      stream.updateInputStream(text);

      return new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream) {
              if (chunk === SynthesizeStream.END_OF_STREAM) {
                console.log('++++ tts node end of stream');
                break;
              }
              controller.enqueue(chunk.frame);
            }
          } catch (error) {
            controller.error(error);
            console.log('++++ tts node error', error);
          }
          console.log('++++ tts node close');
          controller.close();
        },
        cancel() {
          console.log('++++ tts node cancel');
          stream.close();
        },
      });
    },

    async transcriptionNode(
      agent: Agent,
      text: ReadableStream<string>,
      modelSettings: any, // TODO(shubhra): add type
    ): Promise<ReadableStream<string> | null> {
      return text;
    },
  };
}
