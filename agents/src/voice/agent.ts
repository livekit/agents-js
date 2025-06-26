// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-unused-vars */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import {
  type ChatChunk,
  ChatContext,
  ChatMessage,
  type LLM,
  type ToolContext,
} from '../llm/index.js';
import type { STT, SpeechEvent } from '../stt/index.js';
import { StreamAdapter as STTStreamAdapter } from '../stt/index.js';
import { SentenceTokenizer as BasicSentenceTokenizer } from '../tokenize/basic/index.js';
import type { TTS } from '../tts/index.js';
import { SynthesizeStream, StreamAdapter as TTSStreamAdapter } from '../tts/index.js';
import type { VAD } from '../vad.js';
import type { AgentActivity } from './agent_activity.js';
import type { TurnDetectionMode } from './agent_session.js';

export class StopResponse extends Error {
  constructor() {
    super();
    this.name = 'StopResponse';
  }
}

export interface AgentOptions<UserData> {
  instructions: string;
  chatCtx?: ChatContext;
  tools?: ToolContext<UserData>;
  turnDetection?: TurnDetectionMode;
  stt?: STT;
  vad?: VAD;
  llm?: LLM; // TODO: support realtime model
  tts?: TTS;
  mcpServers?: any[]; // TODO: support MCP servers
  allowInterruptions?: boolean;
  minConsecutiveSpeechDelay?: number;
}

export class Agent<UserData = any> {
  private turnDetection?: TurnDetectionMode;
  private _stt?: STT;
  private _vad?: VAD;
  private _llm?: LLM;
  private _tts?: TTS;

  /** @internal */
  _agentActivity?: AgentActivity;

  /** @internal */
  _chatCtx: ChatContext;

  /** @internal */
  _instructions: string;

  /** @internal */
  _tools?: ToolContext<UserData>;

  constructor({
    instructions,
    chatCtx,
    tools,
    turnDetection,
    stt,
    vad,
    llm,
    tts,
  }: AgentOptions<UserData>) {
    this._instructions = instructions;
    this._tools = { ...tools };
    this._chatCtx =
      chatCtx ||
      new ChatContext([
        ChatMessage.create({
          role: 'system',
          content: instructions,
        }),
      ]);

    this.turnDetection = turnDetection;
    this._stt = stt;
    this._vad = vad;
    this._llm = llm;
    this._tts = tts;
    this._agentActivity = undefined; // TODO(shubhra): add type
  }

  get vad(): VAD | undefined {
    return this._vad;
  }

  get stt(): STT | undefined {
    return this._stt;
  }

  get llm(): LLM | undefined {
    return this._llm;
  }

  get tts(): TTS | undefined {
    return this._tts;
  }

  get chatCtx(): ChatContext {
    // TODO(brian): make it readonly
    return this._chatCtx;
  }

  get instructions(): string {
    return this._instructions;
  }

  get toolCtx(): ToolContext<UserData> {
    return { ...this._tools };
  }

  async onEnter(): Promise<void> {}

  async onExit(): Promise<void> {}

  async transcriptionNode(
    text: ReadableStream<string>,
    modelSettings: any, // TODO(AJS-59): add type
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
    toolCtx: ToolContext,
    modelSettings: any, // TODO(AJS-59): add type
  ): Promise<ReadableStream<ChatChunk | string> | null> {
    return Agent.default.llmNode(this, chatCtx, toolCtx, modelSettings);
  }

  async ttsNode(
    text: ReadableStream<string>,
    modelSettings: any, // TODO(AJS-59): add type
  ): Promise<ReadableStream<AudioFrame> | null> {
    return Agent.default.ttsNode(this, text, modelSettings);
  }

  // realtime_audio_output_node

  getActivityOrThrow(): AgentActivity {
    if (!this._agentActivity) {
      throw new Error('Agent activity not found');
    }
    return this._agentActivity;
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
          for await (const event of stream) {
            controller.enqueue(event);
          }
          controller.close();
        },
        cancel() {
          stream.detachInputStream();
          stream.close();
        },
      });
    },

    async llmNode(
      agent: Agent,
      chatCtx: ChatContext,
      toolCtx: ToolContext,
      modelSettings: any, // TODO(AJS-59): add type
    ): Promise<ReadableStream<ChatChunk | string> | null> {
      const activity = agent.getActivityOrThrow();
      // TODO(brian): make parallelToolCalls configurable
      const stream = activity.llm.chat({ chatCtx, toolCtx, parallelToolCalls: true });
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
          for await (const chunk of stream) {
            if (chunk === SynthesizeStream.END_OF_STREAM) {
              break;
            }
            controller.enqueue(chunk.frame);
          }
          controller.close();
        },
        cancel() {
          stream.close();
        },
      });
    },

    async transcriptionNode(
      agent: Agent,
      text: ReadableStream<string>,
      modelSettings: any, // TODO(AJS-59): add type
    ): Promise<ReadableStream<string> | null> {
      return text;
    },
  };
}

export function createAgent<UserData = any>(options: AgentOptions<UserData>): Agent<UserData> {
  return new Agent(options);
}
