// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Mutex } from '@livekit/mutex';
import type { AudioFrame } from '@livekit/rtc-node';
import { Heap } from 'heap-js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ReadableStream } from 'node:stream/web';
import { type ChatContext, ChatMessage } from '../llm/chat_context.js';
import {
  type ChatItem,
  type FunctionCall,
  type GenerationCreatedEvent,
  type InputSpeechStartedEvent,
  type InputSpeechStoppedEvent,
  type InputTranscriptionCompleted,
  LLM,
  RealtimeModel,
  type RealtimeModelError,
  type RealtimeSession,
  type ToolChoice,
  type ToolContext,
} from '../llm/index.js';
import type { LLMError } from '../llm/llm.js';
import { isSameToolChoice, isSameToolContext } from '../llm/tool_context.js';
import { log } from '../log.js';
import type {
  EOUMetrics,
  LLMMetrics,
  RealtimeModelMetrics,
  STTMetrics,
  TTSMetrics,
  VADMetrics,
} from '../metrics/base.js';
import { DeferredReadableStream } from '../stream/deferred_stream.js';
import { STT, type STTError, type SpeechEvent } from '../stt/stt.js';
import { splitWords } from '../tokenize/basic/word.js';
import { TTS, type TTSError } from '../tts/tts.js';
import { Future, Task, cancelAndWait, waitFor } from '../utils.js';
import { VAD, type VADEvent } from '../vad.js';
import type { Agent, ModelSettings } from './agent.js';
import { StopResponse, asyncLocalStorage } from './agent.js';
import { type AgentSession, type TurnDetectionMode } from './agent_session.js';
import {
  AudioRecognition,
  type EndOfTurnInfo,
  type PreemptiveGenerationInfo,
  type RecognitionHooks,
  type _TurnDetector,
} from './audio_recognition.js';
import {
  AgentSessionEventTypes,
  createErrorEvent,
  createFunctionToolsExecutedEvent,
  createMetricsCollectedEvent,
  createSpeechCreatedEvent,
  createUserInputTranscribedEvent,
} from './events.js';
import type { ToolExecutionOutput } from './generation.js';
import {
  type _AudioOut,
  type _TextOut,
  performAudioForwarding,
  performLLMInference,
  performTTSInference,
  performTextForwarding,
  performToolExecutions,
  removeInstructions,
  updateInstructions,
} from './generation.js';
import { SpeechHandle } from './speech_handle.js';

// equivalent to Python's contextvars
const speechHandleStorage = new AsyncLocalStorage<SpeechHandle>();

interface PreemptiveGeneration {
  speechHandle: SpeechHandle;
  userMessage: ChatMessage;
  info: PreemptiveGenerationInfo;
  chatCtx: ChatContext;
  tools: ToolContext;
  toolChoice: ToolChoice | null;
  createdAt: number;
}

export class AgentActivity implements RecognitionHooks {
  private static readonly REPLY_TASK_CANCEL_TIMEOUT = 5000;
  private started = false;
  private audioRecognition?: AudioRecognition;
  private realtimeSession?: RealtimeSession;
  private turnDetectionMode?: Exclude<TurnDetectionMode, _TurnDetector>;
  private logger = log();
  private _draining = false;
  private _currentSpeech?: SpeechHandle;
  private speechQueue: Heap<[number, number, SpeechHandle]>; // [priority, timestamp, speechHandle]
  private q_updated: Future;
  private speechTasks: Set<Task<void>> = new Set();
  private lock = new Mutex();
  private audioStream = new DeferredReadableStream<AudioFrame>();
  // default to null as None, which maps to the default provider tool choice value
  private toolChoice: ToolChoice | null = null;
  private _preemptiveGeneration?: PreemptiveGeneration;

  agent: Agent;
  agentSession: AgentSession;

  /** @internal */
  _mainTask?: Task<void>;
  _userTurnCompletedTask?: Promise<void>;

  constructor(agent: Agent, agentSession: AgentSession) {
    this.agent = agent;
    this.agentSession = agentSession;

    /**
     * Custom comparator to prioritize speech handles with higher priority
     * - Prefer higher priority
     * - Prefer earlier timestamp (so calling a sequence of generateReply() will execute in FIFO order)
     */
    this.speechQueue = new Heap<[number, number, SpeechHandle]>(([p1, t1, _], [p2, t2, __]) => {
      return p1 === p2 ? t1 - t2 : p2 - p1;
    });
    this.q_updated = new Future();

    this.turnDetectionMode =
      typeof this.turnDetection === 'string' ? this.turnDetection : undefined;

    if (this.turnDetectionMode === 'vad' && this.vad === undefined) {
      this.logger.warn(
        'turnDetection is set to "vad", but no VAD model is provided, ignoring the turnDdetection setting',
      );
      this.turnDetectionMode = undefined;
    }

    if (this.turnDetectionMode === 'stt' && this.stt === undefined) {
      this.logger.warn(
        'turnDetection is set to "stt", but no STT model is provided, ignoring the turnDetection setting',
      );
      this.turnDetectionMode = undefined;
    }

    if (this.llm instanceof RealtimeModel) {
      if (this.llm.capabilities.turnDetection && !this.allowInterruptions) {
        this.logger.warn(
          'the RealtimeModel uses a server-side turn detection, allowInterruptions cannot be false, ' +
            'disable turnDetection in the RealtimeModel and use VAD on the AgentSession instead',
        );
      }

      if (this.turnDetectionMode === 'realtime_llm' && !this.llm.capabilities.turnDetection) {
        this.logger.warn(
          'turnDetection is set to "realtime_llm", but the LLM is not a RealtimeModel or the server-side turn detection is not supported/enabled, ignoring the turnDetection setting',
        );
        this.turnDetectionMode = undefined;
      }

      if (this.turnDetectionMode === 'stt') {
        this.logger.warn(
          'turnDetection is set to "stt", but the LLM is a RealtimeModel, ignoring the turnDetection setting',
        );
        this.turnDetectionMode = undefined;
      }

      if (
        this.turnDetectionMode &&
        this.turnDetectionMode !== 'realtime_llm' &&
        this.llm.capabilities.turnDetection
      ) {
        this.logger.warn(
          `turnDetection is set to "${this.turnDetectionMode}", but the LLM is a RealtimeModel and server-side turn detection enabled, ignoring the turnDetection setting`,
        );
        this.turnDetectionMode = undefined;
      }

      // fallback to VAD if server side turn detection is disabled and VAD is available
      if (
        !this.llm.capabilities.turnDetection &&
        this.vad &&
        this.turnDetectionMode === undefined
      ) {
        this.turnDetectionMode = 'vad';
      }
    } else if (this.turnDetectionMode === 'realtime_llm') {
      this.logger.warn(
        'turnDetection is set to "realtime_llm", but the LLM is not a RealtimeModel',
      );
      this.turnDetectionMode = undefined;
    }

    if (
      !this.vad &&
      this.stt &&
      this.llm instanceof LLM &&
      this.allowInterruptions &&
      this.turnDetectionMode === undefined
    ) {
      this.logger.warn(
        'VAD is not set. Enabling VAD is recommended when using LLM and STT ' +
          'for more responsive interruption handling.',
      );
    }
  }

  async start(): Promise<void> {
    // TODO(brian): PR3 - Add span: startSpan = tracer.startSpan('start_agent_activity', { attributes: { 'lk.agent_label': this.agent.label } })
    // TODO(brian): PR3 - Wrap prewarm calls with trace.useSpan(startSpan, endOnExit: false)
    const unlock = await this.lock.lock();
    try {
      this.agent._agentActivity = this;

      if (this.llm instanceof RealtimeModel) {
        this.realtimeSession = this.llm.session();
        this.realtimeSession.on('generation_created', (ev) => this.onGenerationCreated(ev));
        this.realtimeSession.on('input_speech_started', (ev) => this.onInputSpeechStarted(ev));
        this.realtimeSession.on('input_speech_stopped', (ev) => this.onInputSpeechStopped(ev));
        this.realtimeSession.on('input_audio_transcription_completed', (ev) =>
          this.onInputAudioTranscriptionCompleted(ev),
        );
        this.realtimeSession.on('metrics_collected', (ev) => this.onMetricsCollected(ev));
        this.realtimeSession.on('error', (ev) => this.onError(ev));

        removeInstructions(this.agent._chatCtx);
        try {
          await this.realtimeSession.updateInstructions(this.agent.instructions);
        } catch (error) {
          this.logger.error(error, 'failed to update the instructions');
        }

        try {
          await this.realtimeSession.updateChatCtx(this.agent.chatCtx);
        } catch (error) {
          this.logger.error(error, 'failed to update the chat context');
        }

        try {
          await this.realtimeSession.updateTools(this.tools);
        } catch (error) {
          this.logger.error(error, 'failed to update the tools');
        }

        if (!this.llm.capabilities.audioOutput && !this.tts && this.agentSession.output.audio) {
          this.logger.error(
            'audio output is enabled but RealtimeModel has no audio modality ' +
              'and no TTS is set. Either enable audio modality in the RealtimeModel ' +
              'or set a TTS model.',
          );
        }
      } else if (this.llm instanceof LLM) {
        try {
          updateInstructions({
            chatCtx: this.agent._chatCtx,
            instructions: this.agent.instructions,
            addIfMissing: true,
          });
        } catch (error) {
          this.logger.error('failed to update the instructions', error);
        }
      }

      // metrics and error handling
      if (this.llm instanceof LLM) {
        this.llm.on('metrics_collected', (ev) => this.onMetricsCollected(ev));
        this.llm.on('error', (ev) => this.onError(ev));
      }

      if (this.stt instanceof STT) {
        this.stt.on('metrics_collected', (ev) => this.onMetricsCollected(ev));
        this.stt.on('error', (ev) => this.onError(ev));
      }

      if (this.tts instanceof TTS) {
        this.tts.on('metrics_collected', (ev) => this.onMetricsCollected(ev));
        this.tts.on('error', (ev) => this.onError(ev));
      }

      if (this.vad instanceof VAD) {
        this.vad.on('metrics_collected', (ev) => this.onMetricsCollected(ev));
      }

      this.audioRecognition = new AudioRecognition({
        recognitionHooks: this,
        // Disable stt node if stt is not provided
        stt: this.stt ? (...args) => this.agent.sttNode(...args) : undefined,
        vad: this.vad,
        turnDetector: typeof this.turnDetection === 'string' ? undefined : this.turnDetection,
        turnDetectionMode: this.turnDetectionMode,
        minEndpointingDelay: this.agentSession.options.minEndpointingDelay,
        maxEndpointingDelay: this.agentSession.options.maxEndpointingDelay,
      });
      this.audioRecognition.start();
      this.started = true;

      this._mainTask = Task.from(({ signal }) => this.mainTask(signal));
      // TODO(brian): PR3 - Wrap onEnter with tracer.startActiveSpan('on_enter', { attributes: { 'lk.agent_label': this.agent.label }, context: startSpan context })
      this.createSpeechTask({
        task: Task.from(() => this.agent.onEnter()),
        name: 'AgentActivity_onEnter',
      });
    } finally {
      unlock();
    }
  }

  get currentSpeech(): SpeechHandle | undefined {
    return this._currentSpeech;
  }

  get vad(): VAD | undefined {
    return this.agent.vad || this.agentSession.vad;
  }

  get stt(): STT | undefined {
    return this.agent.stt || this.agentSession.stt;
  }

  get llm(): LLM | RealtimeModel | undefined {
    return this.agent.llm || this.agentSession.llm;
  }

  get tts(): TTS | undefined {
    return this.agent.tts || this.agentSession.tts;
  }

  get tools(): ToolContext {
    return this.agent.toolCtx;
  }

  get draining(): boolean {
    return this._draining;
  }

  get realtimeLLMSession(): RealtimeSession | undefined {
    return this.realtimeSession;
  }

  get allowInterruptions(): boolean {
    // TODO(AJS-51): Allow options to be defined in Agent class
    return this.agentSession.options.allowInterruptions;
  }

  get turnDetection(): TurnDetectionMode | undefined {
    // TODO(brian): prioritize using agent.turn_detection
    return this.agentSession.turnDetection;
  }

  get toolCtx(): ToolContext {
    return this.agent.toolCtx;
  }

  async updateChatCtx(chatCtx: ChatContext): Promise<void> {
    chatCtx = chatCtx.copy({ toolCtx: this.toolCtx });

    this.agent._chatCtx = chatCtx;

    if (this.realtimeSession) {
      removeInstructions(chatCtx);
      this.realtimeSession.updateChatCtx(chatCtx);
    } else {
      updateInstructions({
        chatCtx,
        instructions: this.agent.instructions,
        addIfMissing: true,
      });
    }
  }

  updateOptions({ toolChoice }: { toolChoice?: ToolChoice | null }): void {
    if (toolChoice !== undefined) {
      this.toolChoice = toolChoice;
    }

    if (this.realtimeSession) {
      this.realtimeSession.updateOptions({ toolChoice: this.toolChoice });
    }
  }

  attachAudioInput(audioStream: ReadableStream<AudioFrame>): void {
    if (this.audioStream.isSourceSet) {
      this.logger.debug('detaching existing audio input in agent activity');
      this.audioStream.detachSource();
    }

    /**
     * We need to add a deferred ReadableStream layer on top of the audioStream from the agent session.
     * The tee() operation should be applied to the deferred stream, not the original audioStream.
     * This is important because teeing the original stream directly makes it very difficult—if not
     * impossible—to implement stream unlock logic cleanly.
     */
    this.audioStream.setSource(audioStream);
    const [realtimeAudioStream, recognitionAudioStream] = this.audioStream.stream.tee();

    if (this.realtimeSession) {
      this.realtimeSession.setInputAudioStream(realtimeAudioStream);
    }

    if (this.audioRecognition) {
      this.audioRecognition.setInputAudioStream(recognitionAudioStream);
    }
  }

  detachAudioInput(): void {
    this.audioStream.detachSource();
  }

  commitUserTurn() {
    if (!this.audioRecognition) {
      throw new Error('AudioRecognition is not initialized');
    }

    // TODO(brian): add audio_detached flag
    const audioDetached = false;
    this.audioRecognition.commitUserTurn(audioDetached);
  }

  clearUserTurn() {
    this.audioRecognition?.clearUserTurn();
    this.realtimeSession?.clearAudio();
  }

  say(
    text: string | ReadableStream<string>,
    options?: {
      audio?: ReadableStream<AudioFrame>;
      allowInterruptions?: boolean;
      addToChatCtx?: boolean;
    },
  ): SpeechHandle {
    const {
      audio,
      allowInterruptions: defaultAllowInterruptions,
      addToChatCtx = true,
    } = options ?? {};
    let allowInterruptions = defaultAllowInterruptions;

    if (
      !audio &&
      !this.tts &&
      this.agentSession.output.audio &&
      this.agentSession.output.audioEnabled
    ) {
      throw new Error('trying to generate speech from text without a TTS model');
    }

    if (
      this.llm instanceof RealtimeModel &&
      this.llm.capabilities.turnDetection &&
      allowInterruptions === false
    ) {
      this.logger.warn(
        'the RealtimeModel uses a server-side turn detection, allowInterruptions cannot be false when using VoiceAgent.say(), ' +
          'disable turnDetection in the RealtimeModel and use VAD on the AgentTask/VoiceAgent instead',
      );
      allowInterruptions = true;
    }

    const handle = SpeechHandle.create({
      allowInterruptions: allowInterruptions ?? this.allowInterruptions,
    });

    this.agentSession.emit(
      AgentSessionEventTypes.SpeechCreated,
      createSpeechCreatedEvent({
        userInitiated: true,
        source: 'say',
        speechHandle: handle,
      }),
    );
    const task = this.createSpeechTask({
      task: Task.from((abortController: AbortController) =>
        this.ttsTask(handle, text, addToChatCtx, {}, abortController, audio),
      ),
      ownedSpeechHandle: handle,
      name: 'AgentActivity.say_tts',
    });

    task.finally(() => this.onPipelineReplyDone());
    this.scheduleSpeech(handle, SpeechHandle.SPEECH_PRIORITY_NORMAL);
    return handle;
  }

  // -- Metrics and errors --

  private onMetricsCollected = (
    ev: STTMetrics | TTSMetrics | VADMetrics | LLMMetrics | RealtimeModelMetrics,
  ) => {
    const speechHandle = speechHandleStorage.getStore();
    if (speechHandle && (ev.type === 'llm_metrics' || ev.type === 'tts_metrics')) {
      ev.speechId = speechHandle.id;
    }
    this.agentSession.emit(
      AgentSessionEventTypes.MetricsCollected,
      createMetricsCollectedEvent({ metrics: ev }),
    );
  };

  private onError(ev: RealtimeModelError | STTError | TTSError | LLMError): void {
    if (ev.type === 'realtime_model_error') {
      const errorEvent = createErrorEvent(ev.error, this.llm);
      this.agentSession.emit(AgentSessionEventTypes.Error, errorEvent);
    } else if (ev.type === 'stt_error') {
      const errorEvent = createErrorEvent(ev.error, this.stt);
      this.agentSession.emit(AgentSessionEventTypes.Error, errorEvent);
    } else if (ev.type === 'tts_error') {
      const errorEvent = createErrorEvent(ev.error, this.tts);
      this.agentSession.emit(AgentSessionEventTypes.Error, errorEvent);
    } else if (ev.type === 'llm_error') {
      const errorEvent = createErrorEvent(ev.error, this.llm);
      this.agentSession.emit(AgentSessionEventTypes.Error, errorEvent);
    }

    this.agentSession._onError(ev);
  }

  // -- Realtime Session events --

  onInputSpeechStarted(_ev: InputSpeechStartedEvent): void {
    this.logger.info('onInputSpeechStarted');

    if (!this.vad) {
      this.agentSession._updateUserState('speaking');
    }

    // this.interrupt() is going to raise when allow_interruptions is False,
    // llm.InputSpeechStartedEvent is only fired by the server when the turn_detection is enabled.
    try {
      this.interrupt();
    } catch (error) {
      this.logger.error(
        'RealtimeAPI input_speech_started, but current speech is not interruptable, this should never happen!',
        error,
      );
    }
  }

  onInputSpeechStopped(ev: InputSpeechStoppedEvent): void {
    this.logger.info(ev, 'onInputSpeechStopped');

    if (!this.vad) {
      this.agentSession._updateUserState('listening');
    }

    if (ev.userTranscriptionEnabled) {
      this.agentSession.emit(
        AgentSessionEventTypes.UserInputTranscribed,
        createUserInputTranscribedEvent({
          isFinal: false,
          transcript: '',
        }),
      );
    }
  }

  onInputAudioTranscriptionCompleted(ev: InputTranscriptionCompleted): void {
    this.agentSession.emit(
      AgentSessionEventTypes.UserInputTranscribed,
      createUserInputTranscribedEvent({
        transcript: ev.transcript,
        isFinal: ev.isFinal,
      }),
    );

    if (ev.isFinal) {
      const message = ChatMessage.create({
        role: 'user',
        content: ev.transcript,
        id: ev.itemId,
      });
      this.agent._chatCtx.items.push(message);
      this.agentSession._conversationItemAdded(message);
    }
  }

  onGenerationCreated(ev: GenerationCreatedEvent): void {
    if (ev.userInitiated) {
      // user initiated generations are directly handled inside _realtime_reply_task
      return;
    }

    if (this.draining) {
      // copied from python:
      // TODO(shubhra): should we "forward" this new turn to the next agent?
      this.logger.warn('skipping new realtime generation, the agent is draining');
      return;
    }

    const handle = SpeechHandle.create({
      allowInterruptions: this.allowInterruptions,
    });
    this.agentSession.emit(
      AgentSessionEventTypes.SpeechCreated,
      createSpeechCreatedEvent({
        userInitiated: false,
        source: 'generate_reply',
        speechHandle: handle,
      }),
    );
    this.logger.info({ speech_id: handle.id }, 'Creating speech handle');

    this.createSpeechTask({
      task: Task.from((abortController: AbortController) =>
        this.realtimeGenerationTask(handle, ev, {}, abortController),
      ),
      ownedSpeechHandle: handle,
      name: 'AgentActivity.realtimeGeneration',
    });

    this.scheduleSpeech(handle, SpeechHandle.SPEECH_PRIORITY_NORMAL);
  }

  // recognition hooks

  onStartOfSpeech(_ev: VADEvent): void {
    this.agentSession._updateUserState('speaking');
  }

  onEndOfSpeech(ev: VADEvent): void {
    let speechEndTime = Date.now();
    if (ev) {
      speechEndTime = speechEndTime - ev.silenceDuration;
    }
    this.agentSession._updateUserState('listening', speechEndTime);
  }

  onVADInferenceDone(ev: VADEvent): void {
    if (this.turnDetection === 'manual' || this.turnDetection === 'realtime_llm') {
      // skip speech handle interruption for manual and realtime model
      return;
    }

    if (this.llm instanceof RealtimeModel && this.llm.capabilities.turnDetection) {
      // skip speech handle interruption if server side turn detection is enabled
      return;
    }

    if (ev.speechDuration < this.agentSession.options.minInterruptionDuration) {
      return;
    }

    // Refactored interruption word count check:
    // - Always apply minInterruptionWords filtering when STT is available and minInterruptionWords > 0
    // - Apply check to all STT results: empty string, undefined, or any length
    // - This ensures consistent behavior across all interruption scenarios
    if (this.stt && this.agentSession.options.minInterruptionWords > 0 && this.audioRecognition) {
      const text = this.audioRecognition.currentTranscript;
      // TODO(shubhra): better word splitting for multi-language

      // Normalize text: convert undefined/null to empty string for consistent word counting
      const normalizedText = text ?? '';
      const wordCount = splitWords(normalizedText, true).length;

      // Only allow interruption if word count meets or exceeds minInterruptionWords
      // This applies to all cases: empty strings, partial speech, and full speech
      if (wordCount < this.agentSession.options.minInterruptionWords) {
        return;
      }
    }

    this.realtimeSession?.startUserActivity();

    if (
      this._currentSpeech &&
      !this._currentSpeech.interrupted &&
      this._currentSpeech.allowInterruptions
    ) {
      this.logger.info({ 'speech id': this._currentSpeech.id }, 'speech interrupted by VAD');
      this.realtimeSession?.interrupt();
      this._currentSpeech.interrupt();
    }
  }

  onInterimTranscript(ev: SpeechEvent): void {
    if (this.llm instanceof RealtimeModel && this.llm.capabilities.userTranscription) {
      // skip stt transcription if userTranscription is enabled on the realtime model
      return;
    }

    this.agentSession.emit(
      AgentSessionEventTypes.UserInputTranscribed,
      createUserInputTranscribedEvent({
        transcript: ev.alternatives![0].text,
        isFinal: false,
        language: ev.alternatives![0].language,
        // TODO(AJS-106): add multi participant support
      }),
    );
  }

  onFinalTranscript(ev: SpeechEvent): void {
    if (this.llm instanceof RealtimeModel && this.llm.capabilities.userTranscription) {
      // skip stt transcription if userTranscription is enabled on the realtime model
      return;
    }

    this.agentSession.emit(
      AgentSessionEventTypes.UserInputTranscribed,
      createUserInputTranscribedEvent({
        transcript: ev.alternatives![0].text,
        isFinal: true,
        language: ev.alternatives![0].language,
        // TODO(AJS-106): add multi participant support
      }),
    );
  }

  onPreemptiveGeneration(info: PreemptiveGenerationInfo): void {
    if (
      !this.agentSession.options.preemptiveGeneration ||
      this.draining ||
      (this._currentSpeech !== undefined && !this._currentSpeech.interrupted) ||
      !(this.llm instanceof LLM)
    ) {
      return;
    }

    this.cancelPreemptiveGeneration();

    this.logger.info(
      {
        newTranscript: info.newTranscript,
        transcriptConfidence: info.transcriptConfidence,
      },
      'starting preemptive generation',
    );

    const userMessage = ChatMessage.create({
      role: 'user',
      content: info.newTranscript,
    });
    const chatCtx = this.agent.chatCtx.copy();
    const speechHandle = this.generateReply({
      userMessage,
      chatCtx,
      scheduleSpeech: false,
    });

    this._preemptiveGeneration = {
      speechHandle,
      userMessage,
      info,
      chatCtx: chatCtx.copy(),
      tools: { ...this.tools },
      toolChoice: this.toolChoice,
      createdAt: Date.now(),
    };
  }

  private cancelPreemptiveGeneration(): void {
    if (this._preemptiveGeneration !== undefined) {
      this._preemptiveGeneration.speechHandle._cancel();
      this._preemptiveGeneration = undefined;
    }
  }

  private createSpeechTask(options: {
    task: Task<void>;
    ownedSpeechHandle?: SpeechHandle;
    name?: string;
  }): Promise<void> {
    const { task, ownedSpeechHandle } = options;

    this.speechTasks.add(task);
    task.addDoneCallback(() => {
      this.speechTasks.delete(task);
    });

    if (ownedSpeechHandle) {
      ownedSpeechHandle._tasks.push(task);
      task.addDoneCallback(() => {
        if (ownedSpeechHandle._tasks.every((t) => t.done)) {
          ownedSpeechHandle._markDone();
        }
      });
    }

    task.addDoneCallback(() => {
      this.wakeupMainTask();
    });

    return task.result;
  }

  async onEndOfTurn(info: EndOfTurnInfo): Promise<boolean> {
    if (this.draining) {
      this.cancelPreemptiveGeneration();
      this.logger.warn({ user_input: info.newTranscript }, 'skipping user input, task is draining');
      // copied from python:
      // TODO(shubhra): should we "forward" this new turn to the next agent/activity?
      return true;
    }

    // Refactored interruption word count check for consistency with onVADInferenceDone:
    // - Always apply minInterruptionWords filtering when STT is available and minInterruptionWords > 0
    // - Use consistent word splitting logic with splitWords (matching onVADInferenceDone pattern)
    if (
      this.stt &&
      this.turnDetection !== 'manual' &&
      this._currentSpeech &&
      this._currentSpeech.allowInterruptions &&
      !this._currentSpeech.interrupted &&
      this.agentSession.options.minInterruptionWords > 0
    ) {
      const wordCount = splitWords(info.newTranscript, true).length;
      if (wordCount < this.agentSession.options.minInterruptionWords) {
        // avoid interruption if the new_transcript contains fewer words than minInterruptionWords
        this.cancelPreemptiveGeneration();
        this.logger.info(
          {
            wordCount,
            minInterruptionWords: this.agentSession.options.minInterruptionWords,
          },
          'skipping user input, word count below minimum interruption threshold',
        );
        return false;
      }
    }

    const oldTask = this._userTurnCompletedTask;
    this._userTurnCompletedTask = this.createSpeechTask({
      task: Task.from(() => this.userTurnCompleted(info, oldTask)),
      name: 'AgentActivity.userTurnCompleted',
    });
    return true;
  }

  retrieveChatCtx(): ChatContext {
    return this.agentSession.chatCtx;
  }

  private async mainTask(signal: AbortSignal): Promise<void> {
    const abortFuture = new Future();
    const abortHandler = () => {
      abortFuture.resolve();
      signal.removeEventListener('abort', abortHandler);
    };
    signal.addEventListener('abort', abortHandler);

    while (true) {
      await Promise.race([this.q_updated.await, abortFuture.await]);
      if (signal.aborted) break;

      while (this.speechQueue.size() > 0) {
        if (signal.aborted) break;

        const heapItem = this.speechQueue.pop();
        if (!heapItem) {
          throw new Error('Speech queue is empty');
        }
        const speechHandle = heapItem[2];
        this._currentSpeech = speechHandle;
        speechHandle._authorizeGeneration();
        await speechHandle._waitForGeneration();
        this._currentSpeech = undefined;
      }

      // If we're draining and there are no more speech tasks, we can exit.
      // Only speech tasks can bypass draining to create a tool response
      if (this.draining && this.speechTasks.size === 0) {
        this.logger.info('mainTask: draining and no more speech tasks');
        break;
      }

      this.q_updated = new Future();
    }

    this.logger.info('AgentActivity mainTask: exiting');
  }

  private wakeupMainTask(): void {
    this.q_updated.resolve();
  }

  generateReply(options: {
    userMessage?: ChatMessage;
    chatCtx?: ChatContext;
    instructions?: string;
    toolChoice?: ToolChoice | null;
    allowInterruptions?: boolean;
    scheduleSpeech?: boolean;
  }): SpeechHandle {
    const {
      userMessage,
      chatCtx,
      instructions: defaultInstructions,
      toolChoice: defaultToolChoice,
      allowInterruptions: defaultAllowInterruptions,
      scheduleSpeech = true,
    } = options;

    let instructions = defaultInstructions;
    let toolChoice = defaultToolChoice;
    let allowInterruptions = defaultAllowInterruptions;

    if (
      this.llm instanceof RealtimeModel &&
      this.llm.capabilities.turnDetection &&
      allowInterruptions === false
    ) {
      this.logger.warn(
        'the RealtimeModel uses a server-side turn detection, allowInterruptions cannot be false when using VoiceAgent.generateReply(), ' +
          'disable turnDetection in the RealtimeModel and use VAD on the AgentTask/VoiceAgent instead',
      );
      allowInterruptions = true;
    }

    if (this.llm === undefined) {
      throw new Error('trying to generate reply without an LLM model');
    }

    const functionCall = asyncLocalStorage.getStore()?.functionCall;
    if (toolChoice === undefined && functionCall !== undefined) {
      // when generateReply is called inside a tool, set toolChoice to 'none' by default
      toolChoice = 'none';
    }

    const handle = SpeechHandle.create({
      allowInterruptions: allowInterruptions ?? this.allowInterruptions,
    });

    this.agentSession.emit(
      AgentSessionEventTypes.SpeechCreated,
      createSpeechCreatedEvent({
        userInitiated: true,
        source: 'generate_reply',
        speechHandle: handle,
      }),
    );
    this.logger.info({ speech_id: handle.id }, 'Creating speech handle');

    if (this.llm instanceof RealtimeModel) {
      this.createSpeechTask({
        task: Task.from((abortController: AbortController) =>
          this.realtimeReplyTask({
            speechHandle: handle,
            // TODO(brian): support llm.ChatMessage for the realtime model
            userInput: userMessage?.textContent,
            instructions,
            modelSettings: {
              // isGiven(toolChoice) = toolChoice !== undefined
              toolChoice: toOaiToolChoice(toolChoice !== undefined ? toolChoice : this.toolChoice),
            },
            abortController,
          }),
        ),
        ownedSpeechHandle: handle,
        name: 'AgentActivity.realtimeReply',
      });
    } else if (this.llm instanceof LLM) {
      // instructions used inside generateReply are "extra" instructions.
      // this matches the behavior of the Realtime API:
      // https://platform.openai.com/docs/api-reference/realtime-client-events/response/create
      if (instructions) {
        instructions = `${this.agent.instructions}\n${instructions}`;
      }

      const task = this.createSpeechTask({
        task: Task.from((abortController: AbortController) =>
          this.pipelineReplyTask(
            handle,
            chatCtx ?? this.agent.chatCtx,
            this.agent.toolCtx,
            {
              toolChoice: toOaiToolChoice(toolChoice !== undefined ? toolChoice : this.toolChoice),
            },
            abortController,
            instructions ? `${this.agent.instructions}\n${instructions}` : instructions,
            userMessage,
          ),
        ),
        ownedSpeechHandle: handle,
        name: 'AgentActivity.pipelineReply',
      });

      task.finally(() => this.onPipelineReplyDone());
    }

    if (scheduleSpeech) {
      this.scheduleSpeech(handle, SpeechHandle.SPEECH_PRIORITY_NORMAL);
    }
    return handle;
  }

  interrupt(): Future<void> {
    const future = new Future<void>();
    const currentSpeech = this._currentSpeech;

    //TODO(AJS-273): add interrupt for background speeches

    currentSpeech?.interrupt();

    for (const [_, __, speech] of this.speechQueue) {
      speech.interrupt();
    }

    this.realtimeSession?.interrupt();

    if (currentSpeech === undefined) {
      future.resolve();
    } else {
      currentSpeech.addDoneCallback(() => {
        if (future.done) return;
        future.resolve();
      });
    }

    return future;
  }

  private onPipelineReplyDone(): void {
    if (!this.speechQueue.peek() && (!this._currentSpeech || this._currentSpeech.done())) {
      this.agentSession._updateAgentState('listening');
    }
  }

  private async userTurnCompleted(info: EndOfTurnInfo, oldTask?: Promise<void>): Promise<void> {
    if (oldTask) {
      // We never cancel user code as this is very confusing.
      // So we wait for the old execution of onUserTurnCompleted to finish.
      // In practice this is OK because most speeches will be interrupted if a new turn
      // is detected. So the previous execution should complete quickly.
      await oldTask;
    }

    // When the audio recognition detects the end of a user turn:
    //  - check if realtime model server-side turn detection is enabled
    //  - check if there is no current generation happening
    //  - cancel the current generation if it allows interruptions (otherwise skip this current
    //  turn)
    //  - generate a reply to the user input

    if (this.llm instanceof RealtimeModel) {
      if (this.llm.capabilities.turnDetection) {
        return;
      }
      this.realtimeSession?.commitAudio();
    }

    if (this._currentSpeech) {
      if (!this._currentSpeech.allowInterruptions) {
        this.logger.warn(
          { user_input: info.newTranscript },
          'skipping user input, current speech generation cannot be interrupted',
        );
        return;
      }

      this.logger.info(
        { 'speech id': this._currentSpeech.id },
        'speech interrupted, new user turn detected',
      );

      this._currentSpeech.interrupt();
      this.realtimeSession?.interrupt();
    }

    let userMessage: ChatMessage | undefined = ChatMessage.create({
      role: 'user',
      content: info.newTranscript,
    });

    // create a temporary mutable chat context to pass to onUserTurnCompleted
    // the user can edit it for the current generation, but changes will not be kept inside the
    // Agent.chatCtx
    const chatCtx = this.agent.chatCtx.copy();
    const startTime = Date.now();

    try {
      await this.agent.onUserTurnCompleted(chatCtx, userMessage);
    } catch (e) {
      if (e instanceof StopResponse) {
        return;
      }
      this.logger.error({ error: e }, 'error occurred during onUserTurnCompleted');
    }

    const callbackDuration = Date.now() - startTime;

    if (this.llm instanceof RealtimeModel) {
      // ignore stt transcription for realtime model
      userMessage = undefined;
    } else if (this.llm === undefined) {
      return;
    }

    let speechHandle: SpeechHandle | undefined;
    if (this._preemptiveGeneration !== undefined) {
      const preemptive = this._preemptiveGeneration;
      // make sure the onUserTurnCompleted didn't change some request parameters
      // otherwise invalidate the preemptive generation
      if (
        preemptive.info.newTranscript === userMessage?.textContent &&
        preemptive.chatCtx.isEquivalent(chatCtx) &&
        isSameToolContext(preemptive.tools, this.tools) &&
        isSameToolChoice(preemptive.toolChoice, this.toolChoice)
      ) {
        speechHandle = preemptive.speechHandle;
        this.scheduleSpeech(speechHandle, SpeechHandle.SPEECH_PRIORITY_NORMAL);
        this.logger.debug(
          {
            preemptiveLeadTime: Date.now() - preemptive.createdAt,
          },
          'using preemptive generation',
        );
      } else {
        this.logger.warn(
          'preemptive generation enabled but chat context or tools have changed after `onUserTurnCompleted`',
        );
        preemptive.speechHandle._cancel();
      }

      this._preemptiveGeneration = undefined;
    }

    if (speechHandle === undefined) {
      // Ensure the new message is passed to generateReply
      // This preserves the original message id, making it easier for users to track responses
      speechHandle = this.generateReply({ userMessage, chatCtx });
    }

    const eouMetrics: EOUMetrics = {
      type: 'eou_metrics',
      timestamp: Date.now(),
      endOfUtteranceDelayMs: info.endOfUtteranceDelay,
      transcriptionDelayMs: info.transcriptionDelay,
      onUserTurnCompletedDelayMs: callbackDuration,
      lastSpeakingTimeMs: info.stoppedSpeakingAt ?? 0,
      speechId: speechHandle.id,
    };

    this.agentSession.emit(
      AgentSessionEventTypes.MetricsCollected,
      createMetricsCollectedEvent({ metrics: eouMetrics }),
    );
  }

  private async ttsTask(
    speechHandle: SpeechHandle,
    text: string | ReadableStream<string>,
    addToChatCtx: boolean,
    modelSettings: ModelSettings,
    replyAbortController: AbortController,
    audio?: ReadableStream<AudioFrame> | null,
  ): Promise<void> {
    speechHandleStorage.enterWith(speechHandle);

    const transcriptionOutput = this.agentSession.output.transcriptionEnabled
      ? this.agentSession.output.transcription
      : null;

    const audioOutput = this.agentSession.output.audioEnabled
      ? this.agentSession.output.audio
      : null;

    await speechHandle.waitIfNotInterrupted([speechHandle._waitForAuthorization()]);

    if (speechHandle.interrupted) {
      return;
    }

    let baseStream: ReadableStream<string>;
    if (text instanceof ReadableStream) {
      baseStream = text;
    } else {
      baseStream = new ReadableStream({
        start(controller) {
          controller.enqueue(text);
          controller.close();
        },
      });
    }

    const [textSource, audioSource] = baseStream.tee();

    const tasks: Array<Task<void>> = [];

    const trNode = await this.agent.transcriptionNode(textSource, {});
    let textOut: _TextOut | null = null;
    if (trNode) {
      const [textForwardTask, _textOut] = performTextForwarding(
        trNode,
        replyAbortController,
        transcriptionOutput,
      );
      textOut = _textOut;
      tasks.push(textForwardTask);
    }

    const onFirstFrame = () => {
      this.agentSession._updateAgentState('speaking');
    };

    if (!audioOutput) {
      if (textOut) {
        textOut.firstTextFut.await.finally(onFirstFrame);
      }
    } else {
      let audioOut: _AudioOut | null = null;
      if (!audio) {
        // generate audio using TTS
        const [ttsTask, ttsStream] = performTTSInference(
          (...args) => this.agent.ttsNode(...args),
          audioSource,
          modelSettings,
          replyAbortController,
        );
        tasks.push(ttsTask);

        const [forwardTask, _audioOut] = performAudioForwarding(
          ttsStream,
          audioOutput,
          replyAbortController,
        );
        tasks.push(forwardTask);
        audioOut = _audioOut;
      } else {
        // use the provided audio
        const [forwardTask, _audioOut] = performAudioForwarding(
          audio,
          audioOutput,
          replyAbortController,
        );
        tasks.push(forwardTask);
        audioOut = _audioOut;
      }
      audioOut.firstFrameFut.await.finally(onFirstFrame);
    }

    await speechHandle.waitIfNotInterrupted(tasks.map((task) => task.result));

    if (audioOutput) {
      await speechHandle.waitIfNotInterrupted([audioOutput.waitForPlayout()]);
    }

    if (speechHandle.interrupted) {
      replyAbortController.abort();
      await cancelAndWait(tasks, AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
      if (audioOutput) {
        audioOutput.clearBuffer();
        await audioOutput.waitForPlayout();
      }
    }

    if (addToChatCtx) {
      const message = ChatMessage.create({
        role: 'assistant',
        content: textOut?.text || '',
        interrupted: speechHandle.interrupted,
      });
      this.agent._chatCtx.insert(message);
      this.agentSession._conversationItemAdded(message);
    }

    if (this.agentSession.agentState === 'speaking') {
      this.agentSession._updateAgentState('listening');
    }
  }

  // TODO(brian): PR3 - Wrap entire pipelineReplyTask() method with tracer.startActiveSpan('agent_turn')
  private async pipelineReplyTask(
    speechHandle: SpeechHandle,
    chatCtx: ChatContext,
    toolCtx: ToolContext,
    modelSettings: ModelSettings,
    replyAbortController: AbortController,
    instructions?: string,
    newMessage?: ChatMessage,
    toolsMessages?: ChatItem[],
  ): Promise<void> {
    speechHandleStorage.enterWith(speechHandle);

    const audioOutput = this.agentSession.output.audioEnabled
      ? this.agentSession.output.audio
      : null;
    const transcriptionOutput = this.agentSession.output.transcriptionEnabled
      ? this.agentSession.output.transcription
      : null;

    chatCtx = chatCtx.copy();

    // Insert new message into temporary chat context for LLM inference
    if (newMessage) {
      chatCtx.insert(newMessage);
    }

    if (instructions) {
      try {
        updateInstructions({
          chatCtx,
          instructions,
          addIfMissing: true,
        });
      } catch (e) {
        this.logger.error({ error: e }, 'error occurred during updateInstructions');
      }
    }

    const tasks: Array<Task<void>> = [];
    const [llmTask, llmGenData] = performLLMInference(
      // preserve  `this` context in llmNode
      (...args) => this.agent.llmNode(...args),
      chatCtx,
      toolCtx,
      modelSettings,
      replyAbortController,
    );
    tasks.push(llmTask);

    const [ttsTextInput, llmOutput] = llmGenData.textStream.tee();

    let ttsTask: Task<void> | null = null;
    let ttsStream: ReadableStream<AudioFrame> | null = null;
    if (audioOutput) {
      [ttsTask, ttsStream] = performTTSInference(
        (...args) => this.agent.ttsNode(...args),
        ttsTextInput,
        modelSettings,
        replyAbortController,
      );
      tasks.push(ttsTask);
    }

    await speechHandle.waitIfNotInterrupted([speechHandle._waitForScheduled()]);

    // Add new message to actual chat context if the speech is scheduled
    if (newMessage && speechHandle.scheduled) {
      this.agent._chatCtx.insert(newMessage);
      this.agentSession._conversationItemAdded(newMessage);
    }

    if (speechHandle.interrupted) {
      replyAbortController.abort();
      await cancelAndWait(tasks, AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
      return;
    }

    this.agentSession._updateAgentState('thinking');

    await speechHandle.waitIfNotInterrupted([speechHandle._waitForAuthorization()]);
    speechHandle._clearAuthorization();

    const replyStartedAt = Date.now();
    const trNodeResult = await this.agent.transcriptionNode(llmOutput, modelSettings);
    let textOut: _TextOut | null = null;
    if (trNodeResult) {
      const [textForwardTask, _textOut] = performTextForwarding(
        trNodeResult,
        replyAbortController,
        transcriptionOutput,
      );
      tasks.push(textForwardTask);
      textOut = _textOut;
    }

    const onFirstFrame = () => {
      this.agentSession._updateAgentState('speaking');
    };

    let audioOut: _AudioOut | null = null;
    if (audioOutput) {
      if (ttsStream) {
        const [forwardTask, _audioOut] = performAudioForwarding(
          ttsStream,
          audioOutput,
          replyAbortController,
        );
        audioOut = _audioOut;
        tasks.push(forwardTask);
        audioOut.firstFrameFut.await.finally(onFirstFrame);
      } else {
        throw Error('ttsStream is null when audioOutput is enabled');
      }
    } else {
      textOut?.firstTextFut.await.finally(onFirstFrame);
    }

    //TODO(AJS-272): before executing tools, make sure we generated all the text
    // (this ensure everything is kept ordered)

    const onToolExecutionStarted = (_: FunctionCall) => {
      // TODO(brian): handle speech_handle item_added
    };

    const onToolExecutionCompleted = (_: ToolExecutionOutput) => {
      // TODO(brian): handle speech_handle item_added
    };

    const [executeToolsTask, toolOutput] = performToolExecutions({
      session: this.agentSession,
      speechHandle,
      toolCtx,
      toolChoice: modelSettings.toolChoice,
      toolCallStream: llmGenData.toolCallStream,
      controller: replyAbortController,
      onToolExecutionStarted,
      onToolExecutionCompleted,
    });

    await speechHandle.waitIfNotInterrupted(tasks.map((task) => task.result));

    if (audioOutput) {
      await speechHandle.waitIfNotInterrupted([audioOutput.waitForPlayout()]);
    }

    // add the tools messages that triggers this reply to the chat context
    if (toolsMessages) {
      for (const msg of toolsMessages) {
        msg.createdAt = replyStartedAt;
      }
      this.agent._chatCtx.insert(toolsMessages);
    }

    if (speechHandle.interrupted) {
      this.logger.debug(
        { speech_id: speechHandle.id },
        'Aborting all pipeline reply tasks due to interruption',
      );
      replyAbortController.abort();
      await Promise.allSettled(
        tasks.map((task) => task.cancelAndWait(AgentActivity.REPLY_TASK_CANCEL_TIMEOUT)),
      );

      let forwardedText = textOut?.text || '';

      if (audioOutput) {
        audioOutput.clearBuffer();
        const playbackEv = await audioOutput.waitForPlayout();
        if (audioOut?.firstFrameFut.done) {
          // playback EV is valid only if the first frame was already played
          this.logger.info(
            { speech_id: speechHandle.id, playbackPosition: playbackEv.playbackPosition },
            'playout interrupted',
          );
          if (playbackEv.synchronizedTranscript) {
            forwardedText = playbackEv.synchronizedTranscript;
          }
        } else {
          forwardedText = '';
        }
      }

      if (forwardedText) {
        const message = ChatMessage.create({
          role: 'assistant',
          content: forwardedText,
          id: llmGenData.id,
          interrupted: true,
          createdAt: replyStartedAt,
        });
        chatCtx.insert(message);
        this.agent._chatCtx.insert(message);
        this.agentSession._conversationItemAdded(message);
      }

      if (this.agentSession.agentState === 'speaking') {
        this.agentSession._updateAgentState('listening');
      }

      this.logger.info(
        { speech_id: speechHandle.id, message: forwardedText },
        'playout completed with interrupt',
      );
      // TODO(shubhra) add chat message to speech handle
      speechHandle._markGenerationDone();
      await executeToolsTask.cancelAndWait(AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
      return;
    }

    if (textOut && textOut.text) {
      const message = ChatMessage.create({
        role: 'assistant',
        id: llmGenData.id,
        interrupted: false,
        createdAt: replyStartedAt,
        content: textOut.text,
      });
      chatCtx.insert(message);
      this.agent._chatCtx.insert(message);
      this.agentSession._conversationItemAdded(message);
      this.logger.info(
        { speech_id: speechHandle.id, message: textOut.text },
        'playout completed without interruption',
      );
    }

    if (toolOutput.output.length > 0) {
      this.agentSession._updateAgentState('thinking');
    } else if (this.agentSession.agentState === 'speaking') {
      this.agentSession._updateAgentState('listening');
    }

    // mark the playout done before waiting for the tool execution
    speechHandle._markGenerationDone();
    await executeToolsTask.result;

    if (toolOutput.output.length === 0) return;

    // important: no agent output should be used after this point
    const { maxToolSteps } = this.agentSession.options;
    if (speechHandle.numSteps >= maxToolSteps) {
      this.logger.warn(
        { speech_id: speechHandle.id, max_tool_steps: maxToolSteps },
        'maximum number of function calls steps reached',
      );
      return;
    }

    const functionToolsExecutedEvent = createFunctionToolsExecutedEvent({
      functionCalls: [],
      functionCallOutputs: [],
    });
    let shouldGenerateToolReply: boolean = false;
    let newAgentTask: Agent | null = null;
    let ignoreTaskSwitch: boolean = false;

    for (const sanitizedOut of toolOutput.output) {
      if (sanitizedOut.toolCallOutput !== undefined) {
        functionToolsExecutedEvent.functionCalls.push(sanitizedOut.toolCall);
        functionToolsExecutedEvent.functionCallOutputs.push(sanitizedOut.toolCallOutput);
        if (sanitizedOut.replyRequired) {
          shouldGenerateToolReply = true;
        }
      }

      if (newAgentTask !== null && sanitizedOut.agentTask !== undefined) {
        this.logger.error('expected to receive only one agent task from the tool executions');
        ignoreTaskSwitch = true;
        // TODO(brian): should we mark the function call as failed to notify the LLM?
      }

      newAgentTask = sanitizedOut.agentTask ?? null;

      this.logger.debug(
        {
          speechId: speechHandle.id,
          name: sanitizedOut.toolCall?.name,
          args: sanitizedOut.toolCall.args,
          output: sanitizedOut.toolCallOutput?.output,
          isError: sanitizedOut.toolCallOutput?.isError,
        },
        'Tool call execution finished',
      );
    }

    this.agentSession.emit(
      AgentSessionEventTypes.FunctionToolsExecuted,
      functionToolsExecutedEvent,
    );

    let draining = this.draining;
    if (!ignoreTaskSwitch && newAgentTask !== null) {
      this.agentSession.updateAgent(newAgentTask);
      draining = true;
    }

    const toolMessages = [
      ...functionToolsExecutedEvent.functionCalls,
      ...functionToolsExecutedEvent.functionCallOutputs,
    ] as ChatItem[];
    if (shouldGenerateToolReply) {
      chatCtx.insert(toolMessages);

      const handle = SpeechHandle.create({
        allowInterruptions: speechHandle.allowInterruptions,
        stepIndex: speechHandle._stepIndex + 1,
        parent: speechHandle,
      });
      this.agentSession.emit(
        AgentSessionEventTypes.SpeechCreated,
        createSpeechCreatedEvent({
          userInitiated: false,
          source: 'tool_response',
          speechHandle: handle,
        }),
      );

      // Avoid setting tool_choice to "required" or a specific function when
      // passing tool response back to the LLM
      const respondToolChoice = draining || modelSettings.toolChoice === 'none' ? 'none' : 'auto';

      const toolResponseTask = this.createSpeechTask({
        task: Task.from(() =>
          this.pipelineReplyTask(
            handle,
            chatCtx,
            toolCtx,
            { toolChoice: respondToolChoice },
            replyAbortController,
            instructions,
            undefined,
            toolMessages,
          ),
        ),
        ownedSpeechHandle: handle,
        name: 'AgentActivity.pipelineReply',
      });

      toolResponseTask.finally(() => this.onPipelineReplyDone());

      this.scheduleSpeech(handle, SpeechHandle.SPEECH_PRIORITY_NORMAL, true);
    } else if (functionToolsExecutedEvent.functionCallOutputs.length > 0) {
      for (const msg of toolMessages) {
        msg.createdAt = replyStartedAt;
      }
      this.agent._chatCtx.insert(toolMessages);
    }
  }

  private async realtimeGenerationTask(
    speechHandle: SpeechHandle,
    ev: GenerationCreatedEvent,
    modelSettings: ModelSettings,
    replyAbortController: AbortController,
  ): Promise<void> {
    speechHandleStorage.enterWith(speechHandle);

    if (!this.realtimeSession) {
      throw new Error('realtime session is not initialized');
    }
    if (!(this.llm instanceof RealtimeModel)) {
      throw new Error('llm is not a realtime model');
    }

    this.logger.debug(
      { speech_id: speechHandle.id, stepIndex: speechHandle.numSteps },
      'realtime generation started',
    );

    const audioOutput = this.agentSession.output.audioEnabled
      ? this.agentSession.output.audio
      : null;
    const textOutput = this.agentSession.output.transcriptionEnabled
      ? this.agentSession.output.transcription
      : null;
    const toolCtx = this.realtimeSession.tools;

    await speechHandle.waitIfNotInterrupted([speechHandle._waitForAuthorization()]);
    speechHandle._clearAuthorization();

    if (speechHandle.interrupted) {
      return;
    }

    const onFirstFrame = () => {
      this.agentSession._updateAgentState('speaking');
    };

    const readMessages = async (
      abortController: AbortController,
      outputs: Array<[string, _TextOut | null, _AudioOut | null, ('text' | 'audio')[] | undefined]>,
    ) => {
      replyAbortController.signal.addEventListener('abort', () => abortController.abort(), {
        once: true,
      });

      const forwardTasks: Array<Task<void>> = [];
      try {
        for await (const msg of ev.messageStream) {
          if (forwardTasks.length > 0) {
            this.logger.warn(
              'expected to receive only one message generation from the realtime API',
            );
            break;
          }

          const msgModalities = msg.modalities ? await msg.modalities : undefined;
          let ttsTextInput: ReadableStream<string> | null = null;
          let trTextInput: ReadableStream<string>;

          if (msgModalities && !msgModalities.includes('audio') && this.tts) {
            if (this.llm instanceof RealtimeModel && this.llm.capabilities.audioOutput) {
              this.logger.warn(
                'text response received from realtime API, falling back to use a TTS model.',
              );
            }
            const [_ttsTextInput, _trTextInput] = msg.textStream.tee();
            ttsTextInput = _ttsTextInput;
            trTextInput = _trTextInput;
          } else {
            trTextInput = msg.textStream;
          }

          const trNodeResult = await this.agent.transcriptionNode(trTextInput, modelSettings);
          let textOut: _TextOut | null = null;
          if (trNodeResult) {
            const [textForwardTask, _textOut] = performTextForwarding(
              trNodeResult,
              abortController,
              textOutput,
            );
            forwardTasks.push(textForwardTask);
            textOut = _textOut;
          }

          let audioOut: _AudioOut | null = null;
          if (audioOutput) {
            let realtimeAudioResult: ReadableStream<AudioFrame> | null = null;

            if (ttsTextInput) {
              const [ttsTask, ttsStream] = performTTSInference(
                (...args) => this.agent.ttsNode(...args),
                ttsTextInput,
                modelSettings,
                abortController,
              );
              tasks.push(ttsTask);
              realtimeAudioResult = ttsStream;
            } else if (msgModalities && msgModalities.includes('audio')) {
              realtimeAudioResult = await this.agent.realtimeAudioOutputNode(
                msg.audioStream,
                modelSettings,
              );
            } else if (this.llm instanceof RealtimeModel && this.llm.capabilities.audioOutput) {
              this.logger.error(
                'Text message received from Realtime API with audio modality. ' +
                  'This usually happens when text chat context is synced to the API. ' +
                  'Try to add a TTS model as fallback or use text modality with TTS instead.',
              );
            } else {
              this.logger.warn(
                'audio output is enabled but neither tts nor realtime audio is available',
              );
            }

            if (realtimeAudioResult) {
              const [forwardTask, _audioOut] = performAudioForwarding(
                realtimeAudioResult,
                audioOutput,
                abortController,
              );
              forwardTasks.push(forwardTask);
              audioOut = _audioOut;
              audioOut.firstFrameFut.await.finally(onFirstFrame);
            }
          } else if (textOut) {
            textOut.firstTextFut.await.finally(onFirstFrame);
          }
          outputs.push([msg.messageId, textOut, audioOut, msgModalities]);
        }
        await waitFor(forwardTasks);
      } catch (error) {
        this.logger.error(error, 'error reading messages from the realtime API');
      } finally {
        await cancelAndWait(forwardTasks, AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
      }
    };

    const messageOutputs: Array<
      [string, _TextOut | null, _AudioOut | null, ('text' | 'audio')[] | undefined]
    > = [];
    const tasks = [
      Task.from(
        (controller) => readMessages(controller, messageOutputs),
        undefined,
        'AgentActivity.realtime_generation.read_messages',
      ),
    ];

    const [toolCallStream, toolCallStreamForTracing] = ev.functionStream.tee();
    // TODO(brian): append to tracing tees
    const toolCalls: FunctionCall[] = [];

    const readToolStreamTask = async (
      controller: AbortController,
      stream: ReadableStream<FunctionCall>,
    ) => {
      const reader = stream.getReader();
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          this.logger.debug({ tool_call: value }, 'received tool call from the realtime API');
          toolCalls.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    };

    tasks.push(
      Task.from(
        (controller) => readToolStreamTask(controller, toolCallStreamForTracing),
        replyAbortController,
        'AgentActivity.realtime_generation.read_tool_stream',
      ),
    );

    const onToolExecutionStarted = (f: FunctionCall) => {
      speechHandle._itemAdded([f]);
    };

    const onToolExecutionCompleted = (out: ToolExecutionOutput) => {
      if (out.toolCallOutput) {
        speechHandle._itemAdded([out.toolCallOutput]);
      }
    };

    const [executeToolsTask, toolOutput] = performToolExecutions({
      session: this.agentSession,
      speechHandle,
      toolCtx,
      toolCallStream,
      toolChoice: modelSettings.toolChoice,
      controller: replyAbortController,
      onToolExecutionStarted,
      onToolExecutionCompleted,
    });

    await speechHandle.waitIfNotInterrupted(tasks.map((task) => task.result));

    // TODO(brian): add tracing span

    if (audioOutput) {
      await speechHandle.waitIfNotInterrupted([audioOutput.waitForPlayout()]);
      this.agentSession._updateAgentState('listening');
    }

    if (speechHandle.interrupted) {
      this.logger.debug(
        { speech_id: speechHandle.id },
        'Aborting all realtime generation tasks due to interruption',
      );
      replyAbortController.abort();
      await cancelAndWait(tasks, AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);

      if (messageOutputs.length > 0) {
        // there should be only one message
        const [msgId, textOut, audioOut, msgModalities] = messageOutputs[0]!;
        let forwardedText = textOut?.text || '';

        if (audioOutput) {
          audioOutput.clearBuffer();
          const playbackEv = await audioOutput.waitForPlayout();
          let playbackPosition = playbackEv.playbackPosition;
          if (audioOut?.firstFrameFut.done) {
            // playback EV is valid only if the first frame was already played
            this.logger.info(
              { speech_id: speechHandle.id, playbackPosition: playbackEv.playbackPosition },
              'playout interrupted',
            );
            if (playbackEv.synchronizedTranscript) {
              forwardedText = playbackEv.synchronizedTranscript;
            }
          } else {
            forwardedText = '';
            playbackPosition = 0;
          }

          // truncate server-side message
          this.realtimeSession.truncate({
            messageId: msgId,
            audioEndMs: Math.floor(playbackPosition),
            modalities: msgModalities,
            audioTranscript: forwardedText,
          });
        }

        if (forwardedText) {
          const message = ChatMessage.create({
            role: 'assistant',
            content: forwardedText,
            id: msgId,
            interrupted: true,
          });
          this.agent._chatCtx.insert(message);
          speechHandle._itemAdded([message]);
          this.agentSession._conversationItemAdded(message);

          // TODO(brian): add tracing span
        }
        this.logger.info(
          { speech_id: speechHandle.id, message: forwardedText },
          'playout completed with interrupt',
        );
      }
      speechHandle._markGenerationDone();
      await executeToolsTask.cancelAndWait(AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);

      // TODO(brian): close tees
      return;
    }

    if (messageOutputs.length > 0) {
      // there should be only one message
      const [msgId, textOut, _, __] = messageOutputs[0]!;
      const message = ChatMessage.create({
        role: 'assistant',
        content: textOut?.text || '',
        id: msgId,
        interrupted: false,
      });
      this.agent._chatCtx.insert(message);
      speechHandle._itemAdded([message]);
      this.agentSession._conversationItemAdded(message); // mark the playout done before waiting for the tool execution\
      // TODO(brian): add tracing span
    }

    // mark the playout done before waiting for the tool execution
    speechHandle._markGenerationDone();
    // TODO(brian): close tees

    toolOutput.firstToolStartedFuture.await.finally(() => {
      this.agentSession._updateAgentState('thinking');
    });

    await executeToolsTask.result;

    if (toolOutput.output.length === 0) return;

    // important: no agent ouput should be used after this point
    const { maxToolSteps } = this.agentSession.options;
    if (speechHandle.numSteps >= maxToolSteps) {
      this.logger.warn(
        { speech_id: speechHandle.id, max_tool_steps: maxToolSteps },
        'maximum number of function calls steps reached',
      );
      return;
    }

    const functionToolsExecutedEvent = createFunctionToolsExecutedEvent({
      functionCalls: [],
      functionCallOutputs: [],
    });
    let shouldGenerateToolReply: boolean = false;
    let newAgentTask: Agent | null = null;
    let ignoreTaskSwitch: boolean = false;

    for (const sanitizedOut of toolOutput.output) {
      if (sanitizedOut.toolCallOutput !== undefined) {
        functionToolsExecutedEvent.functionCallOutputs.push(sanitizedOut.toolCallOutput);
        if (sanitizedOut.replyRequired) {
          shouldGenerateToolReply = true;
        }
      }

      if (newAgentTask !== null && sanitizedOut.agentTask !== undefined) {
        this.logger.error('expected to receive only one agent task from the tool executions');
        ignoreTaskSwitch = true;
      }

      newAgentTask = sanitizedOut.agentTask ?? null;

      this.logger.debug(
        {
          speechId: speechHandle.id,
          name: sanitizedOut.toolCall?.name,
          args: sanitizedOut.toolCall.args,
          output: sanitizedOut.toolCallOutput?.output,
          isError: sanitizedOut.toolCallOutput?.isError,
        },
        'Tool call execution finished',
      );
    }

    this.agentSession.emit(
      AgentSessionEventTypes.FunctionToolsExecuted,
      functionToolsExecutedEvent,
    );

    let draining = this.draining;
    if (!ignoreTaskSwitch && newAgentTask !== null) {
      this.agentSession.updateAgent(newAgentTask);
      draining = true;
    }

    if (functionToolsExecutedEvent.functionCallOutputs.length > 0) {
      // wait all speeches played before updating the tool output and generating the response
      // most realtime models dont support generating multiple responses at the same time
      while (this.currentSpeech || this.speechQueue.size() > 0) {
        if (
          this.currentSpeech &&
          !this.currentSpeech.done() &&
          this.currentSpeech !== speechHandle
        ) {
          await this.currentSpeech.waitForPlayout();
        } else {
          // Don't block the event loop
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      const chatCtx = this.realtimeSession.chatCtx.copy();
      chatCtx.items.push(...functionToolsExecutedEvent.functionCallOutputs);
      try {
        await this.realtimeSession.updateChatCtx(chatCtx);
      } catch (error) {
        this.logger.warn(
          { error },
          'failed to update chat context before generating the function calls results',
        );
      }
    }

    // skip realtime reply if not required or auto-generated
    if (!shouldGenerateToolReply || this.llm.capabilities.autoToolReplyGeneration) {
      return;
    }

    this.realtimeSession.interrupt();

    const replySpeechHandle = SpeechHandle.create({
      allowInterruptions: speechHandle.allowInterruptions,
      stepIndex: speechHandle.numSteps + 1,
      parent: speechHandle,
    });
    this.agentSession.emit(
      AgentSessionEventTypes.SpeechCreated,
      createSpeechCreatedEvent({
        userInitiated: false,
        source: 'tool_response',
        speechHandle: replySpeechHandle,
      }),
    );

    const toolChoice = draining || modelSettings.toolChoice === 'none' ? 'none' : 'auto';
    this.createSpeechTask({
      task: Task.from((abortController: AbortController) =>
        this.realtimeReplyTask({
          speechHandle: replySpeechHandle,
          modelSettings: { toolChoice },
          abortController,
        }),
      ),
      ownedSpeechHandle: replySpeechHandle,
      name: 'AgentActivity.realtime_reply',
    });

    this.scheduleSpeech(replySpeechHandle, SpeechHandle.SPEECH_PRIORITY_NORMAL, true);
  }

  private async realtimeReplyTask({
    speechHandle,
    modelSettings: { toolChoice },
    userInput,
    instructions,
    abortController,
  }: {
    speechHandle: SpeechHandle;
    modelSettings: ModelSettings;
    abortController: AbortController;
    userInput?: string;
    instructions?: string;
  }): Promise<void> {
    speechHandleStorage.enterWith(speechHandle);

    if (!this.realtimeSession) {
      throw new Error('realtime session is not available');
    }

    await speechHandle.waitIfNotInterrupted([speechHandle._waitForAuthorization()]);

    if (userInput) {
      const chatCtx = this.realtimeSession.chatCtx.copy();
      const message = chatCtx.addMessage({
        role: 'user',
        content: userInput,
      });
      await this.realtimeSession.updateChatCtx(chatCtx);
      this.agent._chatCtx.insert(message);
      this.agentSession._conversationItemAdded(message);
    }

    const originalToolChoice = this.toolChoice;
    if (toolChoice !== undefined) {
      this.realtimeSession.updateOptions({ toolChoice });
    }

    try {
      const generationEvent = await this.realtimeSession.generateReply(instructions);
      await this.realtimeGenerationTask(
        speechHandle,
        generationEvent,
        { toolChoice },
        abortController,
      );
    } finally {
      // reset toolChoice value
      if (toolChoice !== undefined && toolChoice !== originalToolChoice) {
        this.realtimeSession.updateOptions({ toolChoice: originalToolChoice });
      }
    }
  }

  private scheduleSpeech(
    speechHandle: SpeechHandle,
    priority: number,
    force: boolean = false,
  ): void {
    // when force=true, we allow tool responses to bypass draining
    // This allows for tool responses to be generated before the AgentActivity is finalized
    if (this.draining && !force) {
      throw new Error('cannot schedule new speech, the agent is draining');
    }

    // Monotonic time to avoid near 0 collisions
    this.speechQueue.push([priority, Number(process.hrtime.bigint()), speechHandle]);
    speechHandle._markScheduled();
    this.wakeupMainTask();
  }

  // TODO(brian): PR3 - Wrap entire drain() method with tracer.startActiveSpan('drain_agent_activity', { attributes: { 'lk.agent_label': this.agent.label } })
  async drain(): Promise<void> {
    const unlock = await this.lock.lock();
    try {
      if (this._draining) return;

      this.cancelPreemptiveGeneration();
      // TODO(brian): PR3 - Wrap onExit with tracer.startActiveSpan('on_exit', { attributes: { 'lk.agent_label': this.agent.label } })
      this.createSpeechTask({
        task: Task.from(() => this.agent.onExit()),
        name: 'AgentActivity_onExit',
      });

      this.wakeupMainTask();
      this._draining = true;
      await this._mainTask?.result;
    } finally {
      unlock();
    }
  }

  async close(): Promise<void> {
    const unlock = await this.lock.lock();
    try {
      if (!this._draining) {
        this.logger.warn('task closing without draining');
      }

      this.cancelPreemptiveGeneration();
      // Unregister event handlers to prevent duplicate metrics
      if (this.llm instanceof LLM) {
        this.llm.off('metrics_collected', this.onMetricsCollected);
      }
      if (this.realtimeSession) {
        this.realtimeSession.off('generation_created', this.onGenerationCreated);
        this.realtimeSession.off('input_speech_started', this.onInputSpeechStarted);
        this.realtimeSession.off('input_speech_stopped', this.onInputSpeechStopped);
        this.realtimeSession.off(
          'input_audio_transcription_completed',
          this.onInputAudioTranscriptionCompleted,
        );
        this.realtimeSession.off('metrics_collected', this.onMetricsCollected);
      }
      if (this.stt instanceof STT) {
        this.stt.off('metrics_collected', this.onMetricsCollected);
        await this.stt.close();
      }
      if (this.tts instanceof TTS) {
        this.tts.off('metrics_collected', this.onMetricsCollected);
        await this.tts.close();
      }
      if (this.vad instanceof VAD) {
        this.vad.off('metrics_collected', this.onMetricsCollected);
        await this.vad.close();
      }

      this.detachAudioInput();
      await this.realtimeSession?.close();
      await this.audioRecognition?.close();
      await this._mainTask?.cancelAndWait();
    } finally {
      unlock();
    }
  }
}

function toOaiToolChoice(toolChoice: ToolChoice | null): ToolChoice | undefined {
  // we convert null to undefined, which maps to the default provider tool choice value
  return toolChoice !== null ? toolChoice : undefined;
}
