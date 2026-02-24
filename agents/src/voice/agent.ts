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
import type { ChatMessage, FunctionCall } from '../llm/index.js';
import {
  type ChatChunk,
  ChatContext,
  LLM,
  RealtimeModel,
  type ToolChoice,
  type ToolContext,
} from '../llm/index.js';
import { log } from '../log.js';
import type { STT, SpeechEvent } from '../stt/index.js';
import { StreamAdapter as STTStreamAdapter } from '../stt/index.js';
import { SentenceTokenizer as BasicSentenceTokenizer } from '../tokenize/basic/index.js';
import type { TTS } from '../tts/index.js';
import { SynthesizeStream, StreamAdapter as TTSStreamAdapter } from '../tts/index.js';
import { USERDATA_TIMED_TRANSCRIPT } from '../types.js';
import { Future, Task } from '../utils.js';
import type { VAD } from '../vad.js';
import { type AgentActivity, agentActivityStorage } from './agent_activity.js';
import type { AgentSession, TurnDetectionMode } from './agent_session.js';
import type { TimedString } from './io.js';
import type { SpeechHandle } from './speech_handle.js';

export const functionCallStorage = new AsyncLocalStorage<{ functionCall?: FunctionCall }>();
export const speechHandleStorage = new AsyncLocalStorage<SpeechHandle>();
const activityTaskInfoStorage = new WeakMap<Task<any>, _ActivityTaskInfo>();

type _ActivityTaskInfo = {
  functionCall: FunctionCall | null;
  speechHandle: SpeechHandle | null;
  inlineTask: boolean;
};

/** @internal */
export function _setActivityTaskInfo<T>(
  task: Task<T>,
  options: {
    functionCall?: FunctionCall | null;
    speechHandle?: SpeechHandle | null;
    inlineTask?: boolean;
  },
): void {
  const info = activityTaskInfoStorage.get(task) ?? {
    functionCall: null,
    speechHandle: null,
    inlineTask: false,
  };

  if (Object.hasOwn(options, 'functionCall')) {
    info.functionCall = options.functionCall ?? null;
  }
  if (Object.hasOwn(options, 'speechHandle')) {
    info.speechHandle = options.speechHandle ?? null;
  }
  if (Object.hasOwn(options, 'inlineTask')) {
    info.inlineTask = options.inlineTask ?? false;
  }

  activityTaskInfoStorage.set(task, info);
}

/** @internal */
export function _getActivityTaskInfo<T>(task: Task<T>): _ActivityTaskInfo | undefined {
  return activityTaskInfoStorage.get(task);
}
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

  // TODO(parity): Add when AgentConfigUpdate is ported to ChatContext.
  async updateTools(tools: ToolContext): Promise<void> {
    if (!this._agentActivity) {
      this._tools = { ...tools };
      this._chatCtx = this._chatCtx.copy({ toolCtx: this._tools });
      return;
    }

    await this._agentActivity.updateTools(tools);
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

      let wrappedStt = activity.stt;

      if (!wrappedStt.capabilities.streaming) {
        const vad = agent.vad || activity.vad;
        if (!vad) {
          throw new Error(
            'STT does not support streaming, add a VAD to the AgentTask/VoiceAgent to enable streaming',
          );
        }
        wrappedStt = new STTStreamAdapter(wrappedStt, vad);
      }

      const connOptions = activity.agentSession.connOptions.sttConnOptions;
      const stream = wrappedStt.stream({ connOptions });

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

      let wrappedTts = activity.tts;

      if (!activity.tts.capabilities.streaming) {
        wrappedTts = new TTSStreamAdapter(wrappedTts, new BasicSentenceTokenizer());
      }

      const connOptions = activity.agentSession.connOptions.ttsConnOptions;
      const stream = wrappedTts.stream({ connOptions });
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

export class AgentTask<ResultT = unknown, UserData = any> extends Agent<UserData> {
  private started = false;
  private future = new Future<ResultT>();

  #logger = log();

  get done(): boolean {
    return this.future.done;
  }

  complete(result: ResultT | Error): void {
    if (this.future.done) {
      throw new Error(`${this.constructor.name} is already done`);
    }

    if (result instanceof Error) {
      this.future.reject(result);
    } else {
      this.future.resolve(result);
    }

    const speechHandle = speechHandleStorage.getStore();
    if (speechHandle) {
      speechHandle._maybeRunFinalOutput = result;
    }
  }

  async run(): Promise<ResultT> {
    if (this.started) {
      throw new Error(
        `Task ${this.constructor.name} has already started and cannot be awaited multiple times`,
      );
    }
    this.started = true;

    const currentTask = Task.current();
    if (!currentTask) {
      throw new Error(`${this.constructor.name} must be executed inside a Task context`);
    }

    const taskInfo = _getActivityTaskInfo(currentTask);
    if (!taskInfo || !taskInfo.inlineTask) {
      throw new Error(
        `${this.constructor.name} should only be awaited inside function tools or the onEnter/onExit methods of an Agent`,
      );
    }

    const speechHandle = speechHandleStorage.getStore();
    const oldActivity = agentActivityStorage.getStore();
    if (!oldActivity) {
      throw new Error(`${this.constructor.name} must be executed inside an AgentActivity context`);
    }

    currentTask.addDoneCallback(() => {
      if (this.future.done) return;

      // If the Task finished before the AgentTask was completed, complete the AgentTask with an error.
      this.#logger.error(`The Task finished before ${this.constructor.name} was completed.`);
      this.complete(new Error(`The Task finished before ${this.constructor.name} was completed.`));
    });

    const oldAgent = oldActivity.agent;
    const session = oldActivity.agentSession;

    const blockedTasks: Task<any>[] = [currentTask];
    const onEnterTask = oldActivity._onEnterTask;

    if (onEnterTask && !onEnterTask.done && onEnterTask !== currentTask) {
      blockedTasks.push(onEnterTask);
    }

    if (
      taskInfo.functionCall &&
      oldActivity.llm instanceof RealtimeModel &&
      !oldActivity.llm.capabilities.manualFunctionCalls
    ) {
      this.#logger.error(
        `Realtime model does not support resuming function calls from chat context, ` +
          `using AgentTask inside a function tool may have unexpected behavior.`,
      );
    }

    await session._updateActivity(this, {
      previousActivity: 'pause',
      newActivity: 'start',
      blockedTasks,
    });

    let runState = session._globalRunState;
    if (speechHandle && runState && !runState.done()) {
      // Only unwatch the parent speech handle if there are other handles keeping the run alive.
      // When watchedHandleCount is 1 (only the parent), unwatching would drop it to 0 and
      // mark the run done prematurely — before function_call_output and assistant message arrive.
      if (runState._watchedHandleCount() > 1) {
        runState._unwatchHandle(speechHandle);
      }
      // it is OK to call _markDoneIfNeeded here, the above _updateActivity will call onEnter
      // and newly added handles keep the run alive.
      runState._markDoneIfNeeded();
    }

    try {
      return await this.future.await;
    } finally {
      // runState could have changed after future resolved
      runState = session._globalRunState;

      if (session.currentAgent !== this) {
        this.#logger.warn(
          `${this.constructor.name} completed, but the agent has changed in the meantime. ` +
            `Ignoring handoff to the previous agent, likely due to AgentSession.updateAgent being invoked.`,
        );
        await oldActivity.close();
      } else {
        if (speechHandle && runState && !runState.done()) {
          runState._watchHandle(speechHandle);
        }

        const mergedChatCtx = oldAgent._chatCtx.merge(this._chatCtx, {
          excludeFunctionCall: true,
          excludeInstructions: true,
        });
        oldAgent._chatCtx.items = mergedChatCtx.items;

        await session._updateActivity(oldAgent, {
          previousActivity: 'close',
          newActivity: 'resume',
          waitOnEnter: false,
        });
      }
    }
  }
}
