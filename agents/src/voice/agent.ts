// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ReadableStream } from 'node:stream/web';
import {
  LLM as InferenceLLM,
  STT as InferenceSTT,
  TTS as InferenceTTS,
  type LLMModels,
  type STTModelString,
  type TTSModelString,
} from '../inference/index.js';
import { ReadonlyChatContext } from '../llm/chat_context.js';
import type { ChatMessage, FunctionCall, RealtimeModel } from '../llm/index.js';
import {
  type ChatChunk,
  ChatContext,
  LLM,
  type ToolChoice,
  type ToolContext,
} from '../llm/index.js';
import type { STT, SpeechEvent } from '../stt/index.js';
import { StreamAdapter as STTStreamAdapter } from '../stt/index.js';
import { SentenceTokenizer as BasicSentenceTokenizer } from '../tokenize/basic/index.js';
import type { TTS } from '../tts/index.js';
import { SynthesizeStream, StreamAdapter as TTSStreamAdapter } from '../tts/index.js';
import { USERDATA_TIMED_TRANSCRIPT } from '../types.js';
import type { VAD } from '../vad.js';
import type { AgentActivity } from './agent_activity.js';
import type { AgentSession, TurnDetectionMode } from './agent_session.js';
import type { TimedString } from './io.js';

export const asyncLocalStorage = new AsyncLocalStorage<{ functionCall?: FunctionCall }>();
export const STOP_RESPONSE_SYMBOL = Symbol('StopResponse');

export class StopResponse extends Error {
  constructor() {
    super();
    this.name = 'StopResponse';

    Object.defineProperty(this, STOP_RESPONSE_SYMBOL, {
      value: true,
    });
  }
}

export function isStopResponse(value: unknown): value is StopResponse {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === 'object' &&
    STOP_RESPONSE_SYMBOL in value
  );
}

export interface ModelSettings {
  /** The tool choice to use when calling the LLM. */
  toolChoice?: ToolChoice;
}

export interface AgentOptions<UserData> {
  id?: string;
  instructions: string;
  chatCtx?: ChatContext;
  tools?: ToolContext<UserData>;
  turnDetection?: TurnDetectionMode;
  stt?: STT | STTModelString;
  vad?: VAD;
  llm?: LLM | RealtimeModel | LLMModels;
  tts?: TTS | TTSModelString;
  allowInterruptions?: boolean;
  minConsecutiveSpeechDelay?: number;
  useTtsAlignedTranscript?: boolean;
}

export class Agent<UserData = any> {
  private _id: string;
  private turnDetection?: TurnDetectionMode;
  private _stt?: STT;
  private _vad?: VAD;
  private _llm?: LLM | RealtimeModel;
  private _tts?: TTS;
  private _useTtsAlignedTranscript?: boolean;

  /** @internal */
  _agentActivity?: AgentActivity;

  /** @internal */
  _chatCtx: ChatContext;

  /** @internal */
  _instructions: string;

  /** @internal */
  _tools?: ToolContext<UserData>;

  constructor({
    id,
    instructions,
    chatCtx,
    tools,
    turnDetection,
    stt,
    vad,
    llm,
    tts,
    useTtsAlignedTranscript,
  }: AgentOptions<UserData>) {
    if (id) {
      this._id = id;
    } else {
      // Convert class name to snake_case
      const className = this.constructor.name;
      if (className === 'Agent') {
        this._id = 'default_agent';
      } else {
        this._id = className
          .replace(/([A-Z])/g, '_$1')
          .toLowerCase()
          .replace(/^_/, '');
      }
    }

    this._instructions = instructions;
    this._tools = { ...tools };
    this._chatCtx = chatCtx
      ? chatCtx.copy({
          toolCtx: this._tools,
        })
      : ChatContext.empty();

    this.turnDetection = turnDetection;
    this._vad = vad;

    if (typeof stt === 'string') {
      this._stt = InferenceSTT.fromModelString(stt);
    } else {
      this._stt = stt;
    }

    if (typeof llm === 'string') {
      this._llm = InferenceLLM.fromModelString(llm);
    } else {
      this._llm = llm;
    }

    if (typeof tts === 'string') {
      this._tts = InferenceTTS.fromModelString(tts);
    } else {
      this._tts = tts;
    }

    this._useTtsAlignedTranscript = useTtsAlignedTranscript;

    this._agentActivity = undefined;
  }

  get vad(): VAD | undefined {
    return this._vad;
  }

  get stt(): STT | undefined {
    return this._stt;
  }

  get llm(): LLM | RealtimeModel | undefined {
    return this._llm;
  }

  get tts(): TTS | undefined {
    return this._tts;
  }

  get useTtsAlignedTranscript(): boolean | undefined {
    return this._useTtsAlignedTranscript;
  }

  get chatCtx(): ReadonlyChatContext {
    return new ReadonlyChatContext(this._chatCtx.items);
  }

  get id(): string {
    return this._id;
  }

  get instructions(): string {
    return this._instructions;
  }

  get toolCtx(): ToolContext<UserData> {
    return { ...this._tools };
  }

  get session(): AgentSession<UserData> {
    return this.getActivityOrThrow().agentSession as AgentSession<UserData>;
  }

  async onEnter(): Promise<void> {}

  async onExit(): Promise<void> {}

  async transcriptionNode(
    text: ReadableStream<string | TimedString>,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<string | TimedString> | null> {
    return Agent.default.transcriptionNode(this, text, modelSettings);
  }

  async onUserTurnCompleted(_chatCtx: ChatContext, _newMessage: ChatMessage): Promise<void> {}

  async sttNode(
    audio: ReadableStream<AudioFrame>,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<SpeechEvent | string> | null> {
    return Agent.default.sttNode(this, audio, modelSettings);
  }

  async llmNode(
    chatCtx: ChatContext,
    toolCtx: ToolContext,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<ChatChunk | string> | null> {
    return Agent.default.llmNode(this, chatCtx, toolCtx, modelSettings);
  }

  async ttsNode(
    text: ReadableStream<string>,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<AudioFrame> | null> {
    return Agent.default.ttsNode(this, text, modelSettings);
  }

  async realtimeAudioOutputNode(
    audio: ReadableStream<AudioFrame>,
    modelSettings: ModelSettings,
  ): Promise<ReadableStream<AudioFrame> | null> {
    return Agent.default.realtimeAudioOutputNode(this, audio, modelSettings);
  }

  // realtime_audio_output_node

  getActivityOrThrow(): AgentActivity {
    if (!this._agentActivity) {
      throw new Error('Agent activity not found');
    }
    return this._agentActivity;
  }

  async updateChatCtx(chatCtx: ChatContext): Promise<void> {
    if (!this._agentActivity) {
      this._chatCtx = chatCtx.copy({ toolCtx: this.toolCtx });
      return;
    }

    this._agentActivity.updateChatCtx(chatCtx);
  }

  static default = {
    async sttNode(
      agent: Agent,
      audio: ReadableStream<AudioFrame>,
      _modelSettings: ModelSettings,
    ): Promise<ReadableStream<SpeechEvent | string> | null> {
      const activity = agent.getActivityOrThrow();
      if (!activity.stt) {
        throw new Error('sttNode called but no STT node is available');
      }

      let wrapped_stt = activity.stt;

      if (!wrapped_stt.capabilities.streaming) {
        const vad = agent.vad || activity.vad;
        if (!vad) {
          throw new Error(
            'STT does not support streaming, add a VAD to the AgentTask/VoiceAgent to enable streaming',
          );
        }
        wrapped_stt = new STTStreamAdapter(wrapped_stt, vad);
      }

      const connOptions = activity.agentSession.connOptions.sttConnOptions;
      const stream = wrapped_stt.stream({ connOptions });

      // Set startTimeOffset to provide linear timestamps across reconnections
      const audioInputStartedAt =
        activity.agentSession._recorderIO?.recordingStartedAt ?? // Use recording start time if available
        activity.agentSession._startedAt ?? // Fallback to session start time
        Date.now(); // Fallback to current time

      stream.startTimeOffset = (Date.now() - audioInputStartedAt) / 1000;

      stream.updateInputStream(audio);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        stream.detachInputStream();
        stream.close();
      };

      return new ReadableStream({
        async start(controller) {
          try {
            for await (const event of stream) {
              controller.enqueue(event);
            }
            controller.close();
          } finally {
            // Always clean up the STT stream, whether it ends naturally or is cancelled
            cleanup();
          }
        },
        cancel() {
          cleanup();
        },
      });
    },

    async llmNode(
      agent: Agent,
      chatCtx: ChatContext,
      toolCtx: ToolContext,
      modelSettings: ModelSettings,
    ): Promise<ReadableStream<ChatChunk | string> | null> {
      const activity = agent.getActivityOrThrow();
      if (!activity.llm) {
        throw new Error('llmNode called but no LLM node is available');
      }

      if (!(activity.llm instanceof LLM)) {
        throw new Error(
          'llmNode should only be used with LLM (non-multimodal/realtime APIs) nodes',
        );
      }

      const { toolChoice } = modelSettings;
      const connOptions = activity.agentSession.connOptions.llmConnOptions;

      // parallelToolCalls is not passed here - it will use the value from LLM's modelOptions
      // This allows users to configure it via: new inference.LLM({ modelOptions: { parallel_tool_calls: false } })
      const stream = activity.llm.chat({
        chatCtx,
        toolCtx,
        toolChoice,
        connOptions,
      });

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        stream.close();
      };

      return new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream) {
              controller.enqueue(chunk);
            }
            controller.close();
          } finally {
            cleanup();
          }
        },
        cancel() {
          cleanup();
        },
      });
    },

    async ttsNode(
      agent: Agent,
      text: ReadableStream<string>,
      _modelSettings: ModelSettings,
    ): Promise<ReadableStream<AudioFrame> | null> {
      const activity = agent.getActivityOrThrow();
      if (!activity.tts) {
        throw new Error('ttsNode called but no TTS node is available');
      }

      let wrapped_tts = activity.tts;

      if (!activity.tts.capabilities.streaming) {
        wrapped_tts = new TTSStreamAdapter(wrapped_tts, new BasicSentenceTokenizer());
      }

      const connOptions = activity.agentSession.connOptions.ttsConnOptions;
      const stream = wrapped_tts.stream({ connOptions });
      stream.updateInputStream(text);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        stream.close();
      };

      return new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream) {
              if (chunk === SynthesizeStream.END_OF_STREAM) {
                break;
              }
              // Attach timed transcripts to frame.userdata
              if (chunk.timedTranscripts && chunk.timedTranscripts.length > 0) {
                chunk.frame.userdata[USERDATA_TIMED_TRANSCRIPT] = chunk.timedTranscripts;
              }
              controller.enqueue(chunk.frame);
            }
            controller.close();
          } finally {
            cleanup();
          }
        },
        cancel() {
          cleanup();
        },
      });
    },

    async transcriptionNode(
      agent: Agent,
      text: ReadableStream<string | TimedString>,
      _modelSettings: ModelSettings,
    ): Promise<ReadableStream<string | TimedString> | null> {
      return text;
    },

    async realtimeAudioOutputNode(
      _agent: Agent,
      audio: ReadableStream<AudioFrame>,
      _modelSettings: ModelSettings,
    ): Promise<ReadableStream<AudioFrame> | null> {
      return audio;
    },
  };
}
