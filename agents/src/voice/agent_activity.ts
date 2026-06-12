// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Mutex } from '@livekit/mutex';
import type { AudioFrame } from '@livekit/rtc-node';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { Span } from '@opentelemetry/api';
import { ROOT_CONTEXT, context as otelContext, trace } from '@opentelemetry/api';
import { Heap } from 'heap-js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ReadableStream, TransformStream } from 'node:stream/web';
import type { Logger } from 'pino';
import type { InterruptionDetectionError } from '../inference/interruption/errors.js';
import { AdaptiveInterruptionDetector } from '../inference/interruption/interruption_detector.js';
import type { OverlappingSpeechEvent } from '../inference/interruption/types.js';
import {
  AgentConfigUpdate,
  type ChatContext,
  ChatMessage,
  type Instructions,
  type MetricsReport,
  concatInstructions,
  instructionsEqual,
  renderInstructions,
} from '../llm/chat_context.js';
import {
  type ChatItem,
  type FunctionCall,
  type FunctionCallOutput,
  type GenerationCreatedEvent,
  type InputSpeechStartedEvent,
  type InputSpeechStoppedEvent,
  type InputTranscriptionCompleted,
  LLM,
  type MessageGeneration,
  RealtimeModel,
  type RealtimeModelError,
  type RealtimeSession,
  type ToolChoice,
  type ToolContext,
  ToolFlag,
} from '../llm/index.js';
import type { LLMError } from '../llm/llm.js';
import { isSameToolChoice, isSameToolContext } from '../llm/tool_context.js';
import { log } from '../log.js';
import type {
  EOUMetrics,
  InterruptionMetrics,
  LLMMetrics,
  RealtimeModelMetrics,
  STTMetrics,
  TTSMetrics,
  VADMetrics,
} from '../metrics/base.js';
import { IdentityTransform } from '../stream/identity_transform.js';
import { MultiInputStream } from '../stream/multi_input_stream.js';
import { STT, type STTError, type SpeechEvent } from '../stt/stt.js';
import { recordRealtimeMetrics, traceTypes, tracer } from '../telemetry/index.js';
import { splitWords } from '../tokenize/basic/word.js';
import { TTS, type TTSError } from '../tts/tts.js';
import { isFlushSentinel } from '../types.js';
import {
  AsyncIterableQueue,
  Future,
  IdleTimeoutError,
  Task,
  cancelAndWait,
  delay,
  isDevMode,
  isHosted,
  waitForAbort,
  waitUntilTimeout,
} from '../utils.js';
import { VAD, type VADEvent } from '../vad.js';
import {
  Agent,
  type ModelSettings,
  StopResponse,
  _getActivityTaskInfo,
  _setActivityTaskInfo,
  speechHandleStorage,
} from './agent.js';
import { type AgentSession, type TurnDetectionMode } from './agent_session.js';
import {
  AudioRecognition,
  type EndOfTurnInfo,
  type PreemptiveGenerationInfo,
  type RecognitionHooks,
  type STTPipeline,
} from './audio_recognition.js';
import type { AgentState, AgentStateChangedEvent, UserTurnExceededEvent } from './events.js';
import {
  AgentSessionEventTypes,
  createAgentFalseInterruptionEvent,
  createErrorEvent,
  createFunctionToolsExecutedEvent,
  createMetricsCollectedEvent,
  createSessionUsageUpdatedEvent,
  createSpeechCreatedEvent,
  createUserInputTranscribedEvent,
} from './events.js';
import type { ToolExecutionOutput, ToolOutput, _TTSGenerationData } from './generation.js';
import {
  type _AudioOut,
  type _TextOut,
  applyInstructionsModality,
  performAudioForwarding,
  performLLMInference,
  performTTSInference,
  performTextForwarding,
  performToolExecutions,
  removeInstructions,
  updateInstructions,
} from './generation.js';
import type { PlaybackFinishedEvent, TimedString } from './io.js';
import { type InputDetails, SpeechHandle } from './speech_handle.js';
import { type EndpointingOptions, createEndpointing } from './turn_config/endpointing.js';
import { createSilenceFrameLike, setParticipantSpanAttributes } from './utils.js';

export const agentActivityStorage = new AsyncLocalStorage<AgentActivity>();
export const onEnterStorage = new AsyncLocalStorage<OnEnterData>();

interface OnEnterData {
  session: AgentSession;
  agent: Agent;
}

export interface ReusableResources {
  sttPipeline?: STTPipeline;
  sttInputStartedAt?: number;
  rtSession?: RealtimeSession;
}

export class SchedulingPausedError extends Error {
  constructor() {
    super('cannot schedule new speech, the speech scheduling is draining/pausing');
    this.name = 'SchedulingPausedError';
  }
}

export function isSchedulingPausedError(error: unknown): error is SchedulingPausedError {
  return error instanceof SchedulingPausedError;
}

export async function cleanupReusableResources(
  resources: ReusableResources,
  logger: Logger,
): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (resources.sttPipeline) {
    tasks.push(resources.sttPipeline.close());
    resources.sttPipeline = undefined;
  }
  if (resources.rtSession) {
    tasks.push(resources.rtSession.close());
    resources.rtSession = undefined;
  }

  if (tasks.length > 0) {
    const outputs = await ThrowsPromise.allSettled(tasks);
    for (const output of outputs) {
      if (output.status === 'rejected') {
        if (logger) {
          logger.error({ error: output.reason }, 'error cleaning up reusable resources');
        } else {
          console.error('error cleaning up reusable resources', output.reason);
        }
      }
    }
  }
}

interface PreemptiveGeneration {
  speechHandle: SpeechHandle;
  userMessage: ChatMessage;
  info: PreemptiveGenerationInfo;
  chatCtx: ChatContext;
  tools: ToolContext;
  toolChoice: ToolChoice | null;
  createdAt: number;
}

interface PausedSpeechInfo {
  handle: SpeechHandle;
  agentState: AgentState;
  timeout: number;
}

export class AgentActivity implements RecognitionHooks {
  agent: Agent;
  agentSession: AgentSession;

  private static readonly REPLY_TASK_CANCEL_TIMEOUT = 5000;

  private started = false;
  private audioRecognition?: AudioRecognition;
  private realtimeSession?: RealtimeSession;
  private realtimeSpans?: Map<string, Span>; // Maps response_id to OTEL span for metrics recording
  private turnDetectionMode?: TurnDetectionMode;
  private logger = log();
  private _schedulingPaused = true;
  private newTurnsBlocked = false;
  private _authorizationPaused = false;
  private _drainBlockedTasks: Task<any>[] = [];
  private _currentSpeech?: SpeechHandle;
  private speechQueue: Heap<[number, number, SpeechHandle]>; // [priority, timestamp, speechHandle]
  private q_updated: Future<void, never>;
  private speechTasks: Set<Task<void>> = new Set();
  // Handles whose TTS playout has finished but whose tool execution is still running.
  // Tracking them lets interrupt() reach handles that are no longer _currentSpeech but
  // still own an in-flight tool call (which may have scheduled further speech handles).
  private _backgroundSpeeches: Set<SpeechHandle> = new Set();
  // Placeholder used to hold a RunResult open while waiting for a realtime
  // model to auto-generate a tool reply (autoToolReplyGeneration=true).
  private pendingAutoToolReplyFut?: Future<void, never>;
  private lock = new Mutex();
  private audioStream = new MultiInputStream<AudioFrame>();
  private audioStreamId?: string;

  // default to null as None, which maps to the default provider tool choice value
  private toolChoice: ToolChoice | null = null;
  private _preemptiveGeneration?: PreemptiveGeneration;
  private _preemptiveGenerationCount = 0;
  private interruptionDetector?: AdaptiveInterruptionDetector;
  private isInterruptionDetectionEnabled: boolean;
  private isInterruptionByAudioActivityEnabled: boolean;
  private isDefaultInterruptionByAudioActivityEnabled: boolean;

  // for false interruption handling
  private pausedSpeech?: PausedSpeechInfo;
  private falseInterruptionTimer?: NodeJS.Timeout;
  private cancelSpeechPauseTask?: Promise<void>;
  private userTurnExceededLocked = false;
  private userTurnExceededTask?: Task<void>;

  private readonly onRealtimeGenerationCreated = (ev: GenerationCreatedEvent): void =>
    this.onGenerationCreated(ev);

  private readonly onRealtimeInputSpeechStarted = (ev: InputSpeechStartedEvent): void =>
    this.onInputSpeechStarted(ev);

  private readonly onRealtimeInputSpeechStopped = (ev: InputSpeechStoppedEvent): void =>
    this.onInputSpeechStopped(ev);

  private readonly onRealtimeInputAudioTranscriptionCompleted = (
    ev: InputTranscriptionCompleted,
  ): void => this.onInputAudioTranscriptionCompleted(ev);

  private readonly onModelError = (ev: RealtimeModelError | STTError | TTSError | LLMError): void =>
    this.onError(ev);

  private readonly onInterruptionOverlappingSpeech = (ev: OverlappingSpeechEvent): void => {
    this.agentSession.emit(AgentSessionEventTypes.OverlappingSpeech, ev);
  };

  private readonly onInterruptionMetricsCollected = (ev: InterruptionMetrics): void => {
    this.agentSession._usageCollector.collect(ev);
    const usage = this.agentSession.usage;
    this.agentSession.emit(
      AgentSessionEventTypes.MetricsCollected,
      createMetricsCollectedEvent({ metrics: ev }),
    );
    this.agentSession.emit(
      AgentSessionEventTypes.SessionUsageUpdated,
      createSessionUsageUpdatedEvent({ usage }),
    );
  };

  private readonly onInterruptionError = (ev: InterruptionDetectionError): void => {
    if (!ev.recoverable) {
      this.fallbackToVadInterruption(ev);
    }
  };

  /** @internal */
  _mainTask?: Task<void>;
  _onEnterTask?: Task<void>;
  _onExitTask?: Task<void>;
  _userTurnCompletedTask?: Task<void>;

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
        'turnDetection is set to "vad", but no VAD model is provided, ignoring the turnDetection setting',
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
      !this.stt.capabilities.streaming &&
      this.llm instanceof LLM &&
      this.allowInterruptions &&
      this.turnDetectionMode === undefined
    ) {
      this.logger.warn(
        'VAD is not set. Enabling VAD is recommended when using LLM and non-streaming STT ' +
          'for more responsive interruption handling.',
      );
    }

    this.interruptionDetector = this.resolveInterruptionDetector();
    this.isInterruptionDetectionEnabled = !!this.interruptionDetector;

    // this allows taking over audio interruption temporarily until interruption is detected
    // by default is is ture unless turnDetection is manual or realtime_llm
    this.isInterruptionByAudioActivityEnabled =
      this.turnDetectionMode !== 'manual' && this.turnDetectionMode !== 'realtime_llm';

    this.isDefaultInterruptionByAudioActivityEnabled = this.isInterruptionByAudioActivityEnabled;
  }

  async start(options?: { reuseResources?: ReusableResources }): Promise<void> {
    const unlock = await this.lock.lock();
    try {
      await this._startSession({
        spanName: 'start_agent_activity',
        runOnEnter: true,
        reuseResources: options?.reuseResources,
      });
    } finally {
      unlock();
    }
  }

  async resume(options?: { reuseResources?: ReusableResources }): Promise<void> {
    const unlock = await this.lock.lock();
    try {
      await this._startSession({
        spanName: 'resume_agent_activity',
        runOnEnter: false,
        reuseResources: options?.reuseResources,
      });
    } finally {
      unlock();
    }
  }

  private async _startSession(options: {
    spanName: 'start_agent_activity' | 'resume_agent_activity';
    runOnEnter: boolean;
    reuseResources?: ReusableResources;
  }): Promise<void> {
    const { spanName, runOnEnter, reuseResources } = options;
    const startSpan = tracer.startSpan({
      name: spanName,
      attributes: { [traceTypes.ATTR_AGENT_LABEL]: this.agent.id },
      context: ROOT_CONTEXT,
    });

    this.agent._agentActivity = this;

    if (this.llm instanceof RealtimeModel) {
      const rtReused = reuseResources?.rtSession !== undefined;

      if (rtReused) {
        this.logger.debug('reusing realtime session from previous activity');
        this.realtimeSession = reuseResources!.rtSession;
        reuseResources!.rtSession = undefined; // ownership transferred

        // clear any stale audio/generation state
        await this.realtimeSession!.interrupt();
        await this.realtimeSession!.clearAudio();
      } else {
        this.realtimeSession = this.llm.session();
      }

      this.realtimeSpans = new Map<string, Span>();
      this.realtimeSession!.on('generation_created', this.onRealtimeGenerationCreated);
      this.realtimeSession!.on('input_speech_started', this.onRealtimeInputSpeechStarted);
      this.realtimeSession!.on('input_speech_stopped', this.onRealtimeInputSpeechStopped);
      this.realtimeSession!.on(
        'input_audio_transcription_completed',
        this.onRealtimeInputAudioTranscriptionCompleted,
      );
      this.realtimeSession!.on('metrics_collected', this.onMetricsCollected);
      this.realtimeSession!.on('error', this.onModelError);

      removeInstructions(this.agent._chatCtx);

      // skip the update if the session is reused and no mid-session update is supported
      // this means the content is the same as the previous session
      const capabilities = this.llm.capabilities;
      try {
        const realtimeInstructions =
          !rtReused || capabilities.midSessionInstructionsUpdate
            ? renderInstructions(this.agent.instructions)
            : undefined;
        await this.realtimeSession!._updateSession(
          realtimeInstructions,
          !rtReused || capabilities.midSessionChatCtxUpdate ? this.agent.chatCtx : undefined,
          !rtReused || capabilities.midSessionToolsUpdate ? this.tools : undefined,
        );
      } catch (error) {
        this.logger.error(error, 'failed to update realtime session');
      }

      if (!capabilities.audioOutput && !this.tts && this.agentSession.output.audio) {
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

    const initialTools = Object.keys(this.tools);
    if (runOnEnter && (this.agent.instructions || initialTools.length > 0)) {
      const initialConfig = new AgentConfigUpdate({
        instructions: this.agent.instructions,
        toolsAdded: initialTools.length > 0 ? initialTools : undefined,
      });
      this.agent._chatCtx.insert(initialConfig);
      this.agentSession.history.insert(initialConfig);
    }

    // metrics and error handling
    if (this.llm instanceof LLM) {
      this.llm.on('metrics_collected', this.onMetricsCollected);
      this.llm.on('error', this.onModelError);
    }

    if (this.stt instanceof STT) {
      this.stt.on('metrics_collected', this.onMetricsCollected);
      this.stt.on('error', this.onModelError);
    }

    if (this.tts instanceof TTS) {
      this.tts.on('metrics_collected', this.onMetricsCollected);
      this.tts.on('error', this.onModelError);
    }

    if (this.vad instanceof VAD) {
      this.vad.on('metrics_collected', this.onMetricsCollected);
    }

    this.audioRecognition = new AudioRecognition({
      recognitionHooks: this,
      // Disable stt node if stt is not provided
      stt: this.stt ? (...args) => this.agent.sttNode(...args) : undefined,
      vad: this.vad,
      turnDetector: typeof this.turnDetection === 'string' ? undefined : this.turnDetection,
      turnDetectionMode: this.turnDetectionMode,
      interruptionDetection: this.interruptionDetector,
      backchannelBoundary:
        this.agentSession.sessionOptions.turnHandling.interruption.backchannelBoundary,
      endpointing: createEndpointing({
        ...this.agentSession.sessionOptions.turnHandling.endpointing,
        ...(this.agent.turnHandling?.endpointing ?? {}),
      }),
      userTurnLimit: this.agentSession.sessionOptions.turnHandling.userTurnLimit,
      rootSpanContext: this.agentSession.rootSpanContext,
      sttModel: this.stt?.label,
      sttProvider: this.getSttProvider(),
      getLinkedParticipant: () => this.agentSession._roomIO?.linkedParticipant,
      shouldDiscardAudioForStt: () => this.shouldDiscardInputAudio(),
    });

    if (reuseResources?.sttPipeline) {
      this.logger.debug('reusing STT pipeline from previous activity');
      await this.audioRecognition.start({
        sttPipeline: reuseResources.sttPipeline,
        inputStartedAt: reuseResources.sttInputStartedAt,
      });
      reuseResources.sttPipeline = undefined; // ownership transferred
      reuseResources.sttInputStartedAt = undefined;
    } else {
      await this.audioRecognition.start();
    }

    this.started = true;
    this._resumeSchedulingTask();

    if (runOnEnter) {
      this._onEnterTask = this.createSpeechTask({
        taskFn: () =>
          onEnterStorage.run({ session: this.agentSession, agent: this.agent }, () =>
            tracer.startActiveSpan(async () => this.agent.onEnter(), {
              name: 'on_enter',
              context: trace.setSpan(ROOT_CONTEXT, startSpan),
              attributes: { [traceTypes.ATTR_AGENT_LABEL]: this.agent.id },
            }),
          ),
        inlineTask: true,
        name: 'AgentActivity_onEnter',
      });
    }

    startSpan.end();
  }

  async _detachReusableResources(newActivity: AgentActivity): Promise<ReusableResources> {
    const resources: ReusableResources = {};
    try {
      // stt pipeline; only reuse with the default sttNode, a custom override may
      // access the old session/activity inside the yield loop after detach
      if (
        this.audioRecognition &&
        this.stt &&
        newActivity.stt &&
        this.stt === newActivity.stt &&
        Object.getPrototypeOf(this.agent).sttNode === Agent.prototype.sttNode &&
        Object.getPrototypeOf(newActivity.agent).sttNode === Agent.prototype.sttNode
      ) {
        resources.sttPipeline = await this.audioRecognition.detachSttPipeline();
        resources.sttInputStartedAt = this.audioRecognition.inputStartedAt;
      }

      // rt session
      if (
        this.realtimeSession &&
        this.llm instanceof RealtimeModel &&
        this.llm === newActivity.llm
      ) {
        const capabilities = this.llm.capabilities;

        // context update is supported or chat context is equivalent
        let reusable =
          capabilities.midSessionChatCtxUpdate ||
          this.realtimeSession.chatCtx
            .copy({ excludeInstructions: true, excludeHandoff: true, excludeConfigUpdate: true })
            .isEquivalent(
              newActivity.agent.chatCtx.copy({
                excludeInstructions: true,
                excludeHandoff: true,
                excludeConfigUpdate: true,
              }),
            );

        // instructions update is supported or instructions are the same
        reusable =
          reusable &&
          (capabilities.midSessionInstructionsUpdate ||
            instructionsEqual(this.agent.instructions, newActivity.agent.instructions));

        // tools update is supported or tools are the same
        reusable =
          reusable &&
          (capabilities.midSessionToolsUpdate || isSameToolContext(this.tools, newActivity.tools));

        if (reusable) {
          // detach: remove event listeners but don't close the session
          this.realtimeSession.off('generation_created', this.onRealtimeGenerationCreated);
          this.realtimeSession.off('input_speech_started', this.onRealtimeInputSpeechStarted);
          this.realtimeSession.off('input_speech_stopped', this.onRealtimeInputSpeechStopped);
          this.realtimeSession.off(
            'input_audio_transcription_completed',
            this.onRealtimeInputAudioTranscriptionCompleted,
          );
          this.realtimeSession.off('metrics_collected', this.onMetricsCollected);
          this.realtimeSession.off('error', this.onModelError);
          resources.rtSession = this.realtimeSession;
          this.realtimeSession = undefined; // prevent _closeSessionResources from closing it
        }
      }
    } catch (error) {
      await cleanupReusableResources(resources, this.logger);
      throw error;
    }

    return resources;
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

  private getSttProvider(): string | undefined {
    const label = this.stt?.label;
    if (!label) {
      return undefined;
    }

    // Heuristic: most labels look like "<provider>-<model>"
    const [provider] = label.split('-', 1);
    return provider || label;
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

  get schedulingPaused(): boolean {
    return this._schedulingPaused;
  }

  /** @internal */
  blockNewTurns(): void {
    this.newTurnsBlocked = true;
  }

  pauseReplyAuthorization(): void {
    this._authorizationPaused = true;
    this.wakeupMainTask();
  }

  resumeReplyAuthorization(): void {
    if (!this._authorizationPaused) {
      return;
    }

    this._authorizationPaused = false;
    this.wakeupMainTask();
  }

  get realtimeLLMSession(): RealtimeSession | undefined {
    return this.realtimeSession;
  }

  get allowInterruptions(): boolean {
    return (
      this.agent.turnHandling?.interruption?.enabled ??
      this.agentSession.sessionOptions.turnHandling.interruption.enabled
    );
  }

  get useTtsAlignedTranscript(): boolean {
    // Agent setting takes precedence over session setting
    return this.agent.useTtsAlignedTranscript ?? this.agentSession.useTtsAlignedTranscript;
  }

  get turnDetection(): TurnDetectionMode | undefined {
    return this.agent.turnHandling?.turnDetection ?? this.agentSession.turnDetection;
  }

  get turnHandling() {
    return this.agent.turnHandling ?? this.agentSession.sessionOptions.turnHandling;
  }

  // get minEndpointingDelay(): number {
  //   return (
  //     this.agent.turnHandling?.endpointing?.minDelay ??
  //     this.agentSession.sessionOptions.turnHandling.endpointing.minDelay
  //   );
  // }

  get maxEndpointingDelay(): number {
    return (
      this.agent.turnHandling?.endpointing?.maxDelay ??
      this.agentSession.sessionOptions.turnHandling.endpointing.maxDelay
    );
  }

  get toolCtx(): ToolContext {
    return this.agent.toolCtx;
  }

  /** @internal */
  get inputStartedAt() {
    return this.audioRecognition?.inputStartedAt;
  }

  /**
   * @internal — used by AMD to obtain a private branch of the participant
   * audio stream that does not interfere with the pipeline VAD/STT.
   */
  subscribeAudioStream(): ReadableStream<AudioFrame> | undefined {
    return this.audioRecognition?.subscribeAudioStream();
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

  async updateTools(tools: ToolContext): Promise<void> {
    const oldToolNames = new Set(Object.keys(this.tools));
    const newToolNames = new Set(Object.keys(tools));
    const toolsAdded = [...newToolNames].filter((name) => !oldToolNames.has(name));
    const toolsRemoved = [...oldToolNames].filter((name) => !newToolNames.has(name));

    this.agent._tools = { ...tools };

    if (toolsAdded.length > 0 || toolsRemoved.length > 0) {
      const configUpdate = new AgentConfigUpdate({
        toolsAdded: toolsAdded.length > 0 ? toolsAdded : undefined,
        toolsRemoved: toolsRemoved.length > 0 ? toolsRemoved : undefined,
      });
      this.agent._chatCtx.insert(configUpdate);
      this.agentSession.history.insert(configUpdate);
    }

    if (this.realtimeSession) {
      await this.realtimeSession.updateTools(tools);
    }

    if (this.llm instanceof LLM) {
      // for realtime LLM, we assume the server will remove unvalid tool messages
      await this.updateChatCtx(this.agent._chatCtx.copy({ toolCtx: tools }));
    }
  }

  updateOptions(options: {
    endpointing?: EndpointingOptions;
    toolChoice?: ToolChoice | null;
    turnDetection?: TurnDetectionMode | null;
  }): void {
    const { endpointing, toolChoice, turnDetection } = options;
    const hasTurnDetection = turnDetection !== undefined;

    if (toolChoice !== undefined) {
      this.toolChoice = toolChoice;
    }

    if (this.realtimeSession) {
      this.realtimeSession.updateOptions({ toolChoice: this.toolChoice });
    }

    if (hasTurnDetection) {
      this.turnDetectionMode = turnDetection ?? undefined;
      this.isDefaultInterruptionByAudioActivityEnabled =
        this.turnDetectionMode !== 'manual' && this.turnDetectionMode !== 'realtime_llm';

      // sync live flag immediately when not speaking so the change takes effect right away
      if (this.agentSession.agentState !== 'speaking') {
        this.isInterruptionByAudioActivityEnabled =
          this.isDefaultInterruptionByAudioActivityEnabled;
      }
    }

    if (this.audioRecognition) {
      const recognitionOptions: Parameters<AudioRecognition['updateOptions']>[0] = {};
      if (endpointing !== undefined) {
        recognitionOptions.endpointing = createEndpointing({
          ...endpointing,
          ...(this.agent.turnHandling?.endpointing ?? {}),
        });
      }
      if (hasTurnDetection) {
        recognitionOptions.turnDetection = turnDetection;
      }
      this.audioRecognition.updateOptions(recognitionOptions);
    }
  }

  attachAudioInput(audioStream: ReadableStream<AudioFrame>): void {
    void this.audioStream.close();
    this.audioStream = new MultiInputStream<AudioFrame>();

    // Filter is applied on this.audioStream.stream (downstream of MultiInputStream) rather
    // than on the source audioStream via pipeThrough. pipeThrough locks its source stream, so
    // if it were applied directly on audioStream, that lock would survive MultiInputStream.close()
    // and make audioStream permanently locked for subsequent attachAudioInput calls (e.g. handoff).
    const silenceDiscardedAudio = new TransformStream<AudioFrame, AudioFrame>({
      transform: (frame, controller) => {
        controller.enqueue(this.shouldDiscardInputAudio() ? createSilenceFrameLike(frame) : frame);
      },
    });

    this.audioStreamId = this.audioStream.addInputStream(audioStream);

    if (this.realtimeSession && this.audioRecognition) {
      const [realtimeAudioStream, recognitionAudioStream] = this.audioStream.stream.tee();
      this.realtimeSession.setInputAudioStream(
        realtimeAudioStream.pipeThrough(silenceDiscardedAudio),
      );
      this.audioRecognition.setInputAudioStream(recognitionAudioStream);
    } else if (this.realtimeSession) {
      this.realtimeSession.setInputAudioStream(
        this.audioStream.stream.pipeThrough(silenceDiscardedAudio),
      );
    } else if (this.audioRecognition) {
      this.audioRecognition.setInputAudioStream(this.audioStream.stream);
    }
  }

  private shouldDiscardInputAudio(): boolean {
    const aecWarmupActive =
      this.agentSession.agentState === 'speaking' && this.agentSession._aecWarmupRemaining > 0;

    const discardAudioIfUninterruptible =
      this.agent.turnHandling?.interruption?.discardAudioIfUninterruptible ??
      this.agentSession.sessionOptions.turnHandling.interruption.discardAudioIfUninterruptible;

    const uninterruptibleSpeechActive =
      this._currentSpeech !== undefined &&
      !this._currentSpeech.done() &&
      !this._currentSpeech.interrupted &&
      !this._currentSpeech.allowInterruptions &&
      discardAudioIfUninterruptible;

    return aecWarmupActive || uninterruptibleSpeechActive;
  }

  detachAudioInput(): void {
    if (this.audioStreamId === undefined) {
      return;
    }

    void this.audioStream.close();
    this.audioStream = new MultiInputStream<AudioFrame>();
    this.audioStreamId = undefined;
  }

  commitUserTurn(
    options: {
      audioDetached?: boolean;
      throwIfNotReady?: boolean;
    } = {},
  ) {
    const { audioDetached = false, throwIfNotReady = true } = options;
    if (!this.audioRecognition) {
      if (throwIfNotReady) {
        throw new Error('AudioRecognition is not initialized');
      }
      return;
    }

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
    const allowInterruptions = defaultAllowInterruptions;

    if (
      !audio &&
      !this.tts &&
      this.agentSession.output.audio &&
      this.agentSession.output.audioEnabled
    ) {
      throw new Error('trying to generate speech from text without a TTS model');
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
      taskFn: (abortController: AbortController) =>
        this.ttsTask(handle, text, addToChatCtx, {}, abortController, audio),
      ownedSpeechHandle: handle,
      name: 'AgentActivity.tts_say',
    });

    task.result.finally(() => this.onPipelineReplyDone());
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

    // Record realtime metrics on the associated span (if available)
    if (ev.type === 'realtime_model_metrics' && this.realtimeSpans) {
      const span = this.realtimeSpans.get(ev.requestId);
      if (span) {
        recordRealtimeMetrics(span, ev);
        this.realtimeSpans.delete(ev.requestId);
      }
    }

    this.agentSession._usageCollector.collect(ev);
    const usage = this.agentSession.usage;

    this.agentSession.emit(
      AgentSessionEventTypes.MetricsCollected,
      createMetricsCollectedEvent({ metrics: ev }),
    );
    this.agentSession.emit(
      AgentSessionEventTypes.SessionUsageUpdated,
      createSessionUsageUpdatedEvent({ usage }),
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
      if (this.isInterruptionDetectionEnabled && this.audioRecognition) {
        this.audioRecognition.onStartOfOverlapSpeech(
          0,
          Date.now(),
          this.agentSession._userSpeakingSpan,
        );
      }
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
      if (this.isInterruptionDetectionEnabled && this.audioRecognition) {
        this.audioRecognition.onEndOfOverlapSpeech(Date.now(), this.agentSession._userSpeakingSpan);
      }
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
      if (!this.stt && ev.transcript) {
        this.agentSession.amd?.onTranscript(ev.transcript);
      }

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

    if (this.schedulingPaused || this.newTurnsBlocked) {
      // TODO(shubhra): should we "forward" this new turn to the next agent?
      this.logger.warn('skipping new realtime generation, the speech scheduling is not running');
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
      taskFn: (abortController: AbortController) =>
        this.realtimeGenerationTask(handle, ev, {}, abortController),
      ownedSpeechHandle: handle,
      name: 'AgentActivity.realtimeGeneration',
    });

    const fut = this.pendingAutoToolReplyFut;
    if (fut && !fut.done) {
      const runState = this.agentSession._globalRunState;
      if (runState && !runState.done()) {
        runState._watchHandle(handle);
      }
      this.pendingAutoToolReplyFut = undefined;
      fut.resolve();
    }

    this.scheduleSpeech(handle, SpeechHandle.SPEECH_PRIORITY_NORMAL);
  }

  // recognition hooks
  onStartOfSpeech(ev: VADEvent): void {
    let speechStartTime = Date.now();
    if (ev) {
      // Subtract both speechDuration and inferenceDuration to correct for VAD model latency.
      speechStartTime = speechStartTime - ev.speechDuration - ev.inferenceDuration;
    }
    this.agentSession._updateUserState('speaking', {
      lastSpeakingTime: speechStartTime,
      otelContext: otelContext.active(),
    });
    // Mirrors python AudioRecognition._on_vad_event → amd._on_user_speech_started().
    this.agentSession.amd?.onUserSpeechStarted();
    if (this.isInterruptionDetectionEnabled && this.audioRecognition) {
      // Pass speechStartTime as the absolute startedAt timestamp.
      this.audioRecognition.onStartOfOverlapSpeech(
        ev.speechDuration,
        speechStartTime,
        this.agentSession._userSpeakingSpan,
      );
    }

    if (this.falseInterruptionTimer) {
      // cancel the timer when user starts speaking but leave the paused state unchanged
      clearTimeout(this.falseInterruptionTimer);
      this.falseInterruptionTimer = undefined;
    }

    if (
      this.agentSession.agentState !== 'speaking' &&
      this.pauseEnabled() &&
      this._currentSpeech !== undefined &&
      !this._currentSpeech.interrupted &&
      this._currentSpeech.allowInterruptions &&
      (!this.pausedSpeech || this.pausedSpeech.handle !== this._currentSpeech)
    ) {
      // pause the audio output if agent is not speaking (in thinking state);
      // resume immediately when user stops speaking, the timeout will be updated
      // by interruptByAudioActivity
      const audioOutput = this.agentSession.output.audio!;
      this.updatePausedSpeech(this._currentSpeech, 0);
      audioOutput.pause();
    }
  }

  onEndOfSpeech(ev: VADEvent): void {
    let speechEndTime = Date.now();
    let silenceDurationMs = 0;
    if (ev) {
      // Subtract both silenceDuration and inferenceDuration to correct for VAD model latency.
      speechEndTime = speechEndTime - ev.silenceDuration - ev.inferenceDuration;
      silenceDurationMs = ev.silenceDuration;
    }
    if (this.isInterruptionDetectionEnabled && this.audioRecognition) {
      // Pass speechEndTime as the absolute endedAt timestamp.
      this.audioRecognition.onEndOfOverlapSpeech(
        speechEndTime,
        this.agentSession._userSpeakingSpan,
      );
    }
    this.agentSession._updateUserState('listening', {
      lastSpeakingTime: speechEndTime,
      otelContext: otelContext.active(),
    });
    // Mirrors python AudioRecognition._on_vad_event → amd._on_user_speech_ended(ev.silence_duration).
    this.agentSession.amd?.onUserSpeechEnded(silenceDurationMs);

    if (this.pausedSpeech) {
      this.startFalseInterruptionTimer(this.pausedSpeech.timeout);
    }
  }

  onVADInferenceDone(ev: VADEvent): void {
    if (this.turnDetection === 'manual' || this.turnDetection === 'realtime_llm') {
      // skip speech handle interruption for manual and realtime model
      return;
    }

    if (
      ev.speechDuration >= this.agentSession.sessionOptions.turnHandling.interruption?.minDuration
    ) {
      this.interruptByAudioActivity();
    }
  }

  private interruptByAudioActivity(options?: { ignoreUserTranscriptUntil?: number }): void {
    if (!this.isInterruptionByAudioActivityEnabled) {
      return;
    }

    if (this.agentSession._aecWarmupRemaining > 0) {
      // Disable interruption from audio activity while AEC warmup is active.
      return;
    }

    if (this.llm instanceof RealtimeModel && this.llm.capabilities.turnDetection) {
      // skip speech handle interruption if server side turn detection is enabled
      return;
    }

    if (
      this.stt &&
      this.agentSession.sessionOptions.turnHandling.interruption?.minWords > 0 &&
      this.audioRecognition
    ) {
      const text = this.audioRecognition.currentTranscript;
      // TODO(shubhra): better word splitting for multi-language
      const wordCount = splitWords(text ?? '', true).length;
      if (wordCount < this.agentSession.sessionOptions.turnHandling.interruption?.minWords) {
        return;
      }
    }

    this.realtimeSession?.startUserActivity();

    if (
      this._currentSpeech &&
      !this._currentSpeech.interrupted &&
      this._currentSpeech.allowInterruptions
    ) {
      if (this.falseInterruptionTimer) {
        clearTimeout(this.falseInterruptionTimer);
        this.falseInterruptionTimer = undefined;
      }

      if (this.pauseEnabled()) {
        const timeout =
          this.agentSession.sessionOptions.turnHandling.interruption.falseInterruptionTimeout;
        const audioOutput = this.agentSession.output.audio;

        // Gate the pause-side effects on the actual `speaking → listening` transition;
        // otherwise each VAD frame during user speech re-fires onEndOfAgentSpeech and
        // spams the interruption stream with duplicate `agent-speech-ended` sentinels.
        const wasAgentSpeaking = this.agentSession.agentState === 'speaking';

        if (wasAgentSpeaking && this.isInterruptionDetectionEnabled && this.audioRecognition) {
          this.audioRecognition.onStartOfOverlapSpeech(
            0,
            Date.now(),
            this.agentSession._userSpeakingSpan,
          );
        }

        this.updatePausedSpeech(this._currentSpeech, timeout);
        audioOutput!.pause();
        if (wasAgentSpeaking) {
          this.agentSession._updateAgentState('listening');
          if (this.audioRecognition) {
            this.audioRecognition.onEndOfAgentSpeech(
              options?.ignoreUserTranscriptUntil ?? Date.now(),
            );
          }
          if (this.isInterruptionDetectionEnabled) {
            this.restoreInterruptionByAudioActivity();
          }
        }
      } else {
        this.logger.info(
          { 'speech id': this._currentSpeech.id },
          'speech interrupted by audio activity',
        );
        this.realtimeSession?.interrupt();
        this._currentSpeech.interrupt();
      }
    }
  }

  onInterruption(ev: OverlappingSpeechEvent) {
    this.restoreInterruptionByAudioActivity();
    this.interruptByAudioActivity({
      ignoreUserTranscriptUntil: ev.overlapStartedAt || ev.detectedAt,
    });
    if (this.audioRecognition) {
      this.audioRecognition.onEndOfAgentSpeech(ev.overlapStartedAt || ev.detectedAt);
    }
  }

  onInterimTranscript(ev: SpeechEvent, speaking: boolean | undefined): void {
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
        speakerId: ev.alternatives![0].speakerId ?? null,
      }),
    );

    if (
      ev.alternatives![0].text &&
      this.turnDetection !== 'manual' &&
      this.turnDetection !== 'realtime_llm'
    ) {
      this.interruptByAudioActivity();

      if (
        speaking === false &&
        this.pausedSpeech &&
        this.agentSession.sessionOptions.turnHandling.interruption.falseInterruptionTimeout !==
          undefined
      ) {
        // schedule a resume timer if interrupted after end_of_speech
        this.startFalseInterruptionTimer(
          this.agentSession.sessionOptions.turnHandling.interruption.falseInterruptionTimeout,
        );
      }
    }
  }

  onFinalTranscript(ev: SpeechEvent, speaking: boolean | undefined): void {
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
        speakerId: ev.alternatives![0].speakerId ?? null,
      }),
    );
    // Mirrors python AudioRecognition._on_stt_event → amd._on_transcript(transcript).
    this.agentSession.amd?.onTranscript(ev.alternatives![0].text);

    // agent speech might not be interrupted if VAD failed and a final transcript is received
    // we call interruptByAudioActivity (idempotent) to pause the speech, if possible
    if (
      this.audioRecognition &&
      this.turnDetection !== 'manual' &&
      this.turnDetection !== 'realtime_llm'
    ) {
      this.interruptByAudioActivity();

      if (
        speaking === false &&
        this.pausedSpeech &&
        this.agentSession.sessionOptions.turnHandling.interruption.falseInterruptionTimeout !==
          undefined
      ) {
        // schedule a resume timer if interrupted after end_of_speech
        this.startFalseInterruptionTimer(
          this.agentSession.sessionOptions.turnHandling.interruption.falseInterruptionTimeout,
        );
      }
    }

    this.cancelSpeechPauseTask = this.cancelSpeechPause();
  }

  onPreemptiveGeneration(info: PreemptiveGenerationInfo): void {
    const preemptiveOpts = this.agentSession.sessionOptions.turnHandling.preemptiveGeneration;
    if (
      !preemptiveOpts.enabled ||
      this.schedulingPaused ||
      this.newTurnsBlocked ||
      (this._currentSpeech !== undefined && !this._currentSpeech.interrupted) ||
      !(this.llm instanceof LLM)
    ) {
      return;
    }

    this.cancelPreemptiveGeneration();

    if (
      info.startedSpeakingAt !== undefined &&
      Date.now() - info.startedSpeakingAt > preemptiveOpts.maxSpeechDuration
    ) {
      return;
    }

    if (this._preemptiveGenerationCount >= preemptiveOpts.maxRetries) {
      return;
    }

    this._preemptiveGenerationCount++;

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
      transcriptConfidence: info.transcriptConfidence,
    });
    const chatCtx = this.agent.chatCtx.copy();
    const speechHandle = this.generateReply({
      userMessage,
      chatCtx,
      scheduleSpeech: false,
      inputDetails: { modality: 'audio' },
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

  onUserTurnExceeded(ev: UserTurnExceededEvent): void {
    if (this.userTurnExceededLocked) {
      return;
    }

    this.userTurnExceededTask?.cancel();
    this.userTurnExceededTask = this.createSpeechTask({
      taskFn: (controller) => this.runUserTurnExceededTask(ev, controller.signal),
      name: 'AgentActivity.userTurnExceeded',
    });
  }

  private async runUserTurnExceededTask(
    ev: UserTurnExceededEvent,
    signal: AbortSignal,
  ): Promise<void> {
    // Let the current STT event finish scheduling the regular EOU task first.
    await delay(0, { signal });

    const agentSpeaking = new Future<void, never>();
    const onAgentStateChanged = (stateEv: AgentStateChangedEvent): void => {
      if (stateEv.newState === 'speaking' && !agentSpeaking.done) {
        agentSpeaking.resolve();
      }
    };

    if (this.agentSession.agentState === 'speaking') {
      agentSpeaking.resolve();
    } else {
      this.agentSession.on(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
    }

    const waitInactiveTask = Task.from(
      (controller) =>
        this.waitForInactive({ waitForAgent: true, waitForUser: false }, controller.signal),
      undefined,
      'AgentActivity.waitForInactiveForUserTurnExceeded',
    );
    const onAbort = () => waitInactiveTask.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    const waitInactiveResult = waitInactiveTask.result.catch((error) => {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      throw error;
    });
    void waitInactiveResult.catch(() => undefined);

    try {
      await ThrowsPromise.race([agentSpeaking.await, waitInactiveResult, waitForAbort(signal)]);
      if (signal.aborted) {
        return;
      }
      if (agentSpeaking.done) {
        return;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.agentSession.off(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
      if (!waitInactiveTask.done) {
        waitInactiveTask.cancel();
      }
    }

    this.logger.debug(
      { numWords: ev.accumulatedWordCount, duration: ev.duration },
      'user turn limit exceeded',
    );
    this.userTurnExceededLocked = true;
    try {
      await this.agent.onUserTurnExceeded(ev);
    } catch (error) {
      this.logger.error({ error }, 'error in onUserTurnExceeded callback');
    } finally {
      this.userTurnExceededLocked = false;
      this.userTurnExceededTask = undefined;
    }
  }

  private cancelPreemptiveGeneration(): void {
    if (this._preemptiveGeneration !== undefined) {
      this._preemptiveGeneration.speechHandle._cancel();
      this._preemptiveGeneration = undefined;
    }
  }

  private _interruptBackgroundSpeeches(force: boolean): SpeechHandle[] {
    const interrupted: SpeechHandle[] = [];
    for (const speech of this._backgroundSpeeches) {
      if (force || speech.allowInterruptions) {
        interrupted.push(speech.interrupt(force));
      }
    }
    return interrupted;
  }

  private createSpeechTask(options: {
    taskFn: (controller: AbortController) => Promise<void>;
    controller?: AbortController;
    ownedSpeechHandle?: SpeechHandle;
    inlineTask?: boolean;
    name?: string;
  }): Task<void> {
    const { taskFn, controller, ownedSpeechHandle, inlineTask, name } = options;

    const wrappedFn = (ctrl: AbortController) => {
      return agentActivityStorage.run(this, () => {
        // Mark inline/speech metadata at task runtime to avoid a race where taskFn executes
        // before post-construction metadata is attached to the Task instance.
        const currentTask = Task.current();
        if (currentTask) {
          _setActivityTaskInfo(currentTask, { speechHandle: ownedSpeechHandle, inlineTask });
        }

        if (ownedSpeechHandle) {
          return speechHandleStorage.run(ownedSpeechHandle, () => taskFn(ctrl));
        }
        return taskFn(ctrl);
      });
    };

    const task = Task.from(wrappedFn, controller, name);
    _setActivityTaskInfo(task, { speechHandle: ownedSpeechHandle, inlineTask });

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

    return task;
  }

  async onEndOfTurn(info: EndOfTurnInfo): Promise<boolean> {
    // When AMD has taken over the turn with a machine verdict, the caller drives
    // its own reply (e.g. leaving a voicemail). Cancel any post-verdict preemptive
    // generation and mark the turn so the normal auto-reply is skipped, otherwise
    // it would race with — and interrupt — the caller's generateReply.
    const amd = this.agentSession?.amd;
    if (amd && amd.onEndOfTurn(info)) {
      this.cancelPreemptiveGeneration();
      info.skipReply = true;
    }

    if (this.schedulingPaused || this.newTurnsBlocked) {
      this.cancelPreemptiveGeneration();
      this.logger.warn(
        { user_input: info.newTranscript },
        'skipping user input, speech scheduling is paused',
      );
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
      this.agentSession.sessionOptions.turnHandling.interruption?.minWords > 0
    ) {
      const wordCount = splitWords(info.newTranscript, true).length;
      if (wordCount < this.agentSession.sessionOptions.turnHandling.interruption?.minWords) {
        // avoid interruption if the new_transcript contains fewer words than minInterruptionWords
        this.cancelPreemptiveGeneration();
        this.logger.info(
          {
            wordCount,
            minInterruptionWords:
              this.agentSession.sessionOptions.turnHandling.interruption.minWords,
          },
          'skipping user input, word count below minimum interruption threshold',
        );
        return false;
      }
    }

    const oldTask = this._userTurnCompletedTask;
    this._userTurnCompletedTask = this.createSpeechTask({
      taskFn: () => this.userTurnCompleted(info, oldTask),
      name: 'AgentActivity.userTurnCompleted',
    });
    return true;
  }

  retrieveChatCtx(): ChatContext {
    return this.agentSession.chatCtx;
  }

  private async waitForInactive(
    options: { waitForAgent?: boolean; waitForUser?: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    const waitForAgent = options.waitForAgent ?? true;
    const waitForUser = options.waitForUser ?? true;
    let agentActive = true;
    let userActive = true;

    while ((waitForAgent && agentActive) || (waitForUser && userActive)) {
      if (signal.aborted) {
        return;
      }

      if (waitForAgent) {
        if (this.audioRecognition) {
          await this.waitForOrAbort(
            this.audioRecognition.waitForEndOfTurnTask(),
            signal,
            'error waiting for end-of-turn task',
          );
        }

        if (!this._currentSpeech && this.speechQueue.size() === 0) {
          agentActive = false;
        } else {
          agentActive = true;
          const currentUpdate = this.q_updated;
          if (currentUpdate.done) {
            await delay(0, { signal });
          } else {
            await this.waitForOrAbort(
              currentUpdate.await,
              signal,
              'error waiting for speech queue update',
            );
          }
        }
      }

      if (waitForUser) {
        userActive = this.agentSession.userState !== 'listening';
        if (userActive) {
          await delay(0, { signal });
        }
      }
    }
  }

  private async waitForOrAbort(
    promise: Promise<void>,
    signal: AbortSignal,
    errorMessage: string,
  ): Promise<void> {
    try {
      await Promise.race([promise, waitForAbort(signal)]);
    } catch (error) {
      if (!signal.aborted) {
        this.logger.error({ error }, errorMessage);
      }
    }
  }

  private async mainTask(signal: AbortSignal): Promise<void> {
    const abortFuture = new Future<void, never>();
    const abortHandler = () => {
      abortFuture.resolve();
      signal.removeEventListener('abort', abortHandler);
    };
    signal.addEventListener('abort', abortHandler);

    while (true) {
      await ThrowsPromise.race([this.q_updated.await, abortFuture.await]);
      if (signal.aborted) break;

      while (this.speechQueue.size() > 0) {
        if (signal.aborted) break;

        const heapItem = this.speechQueue.pop();
        if (!heapItem) {
          throw new Error('Speech queue is empty');
        }
        if (this._authorizationPaused) {
          this.speechQueue.push(heapItem);
          break;
        }
        const speechHandle = heapItem[2];

        // Skip speech handles that were already interrupted/done before being
        // picked up from the queue (e.g. interrupted during shutdown before the
        // main loop had a chance to process them). Calling _authorizeGeneration
        // on a done handle would create a generation Future that nobody resolves,
        // causing the main loop to hang forever.
        if (speechHandle.interrupted || speechHandle.done()) {
          continue;
        }

        this._currentSpeech = speechHandle;
        speechHandle._authorizeGeneration();
        await speechHandle.waitIfNotInterrupted([speechHandle._waitForGeneration()]);
        this._currentSpeech = undefined;
      }

      // if we're draining/pausing and there are no more speech tasks, we can exit.
      // only speech tasks can bypass draining to create a tool response (see scheduleSpeech)
      const toWait = this.getDrainPendingSpeechTasks();

      if (this._schedulingPaused && toWait.length === 0) {
        this.logger.info('mainTask: scheduling paused and no more speech tasks to wait');
        break;
      }

      this.q_updated = new Future();
    }

    this.logger.info('AgentActivity mainTask: exiting');
  }

  private getDrainPendingSpeechTasks(): Task<void>[] {
    const blockedHandles: SpeechHandle[] = [];

    for (const task of this._drainBlockedTasks) {
      const info = _getActivityTaskInfo(task);
      if (!info) {
        this.logger.error('blocked task without activity info; skipping.');
        continue;
      }

      if (!info.speechHandle) {
        continue; // onEnter/onExit
      }

      blockedHandles.push(info.speechHandle);
    }

    const toWait: Task<void>[] = [];
    for (const task of this.speechTasks) {
      if (this._drainBlockedTasks.includes(task)) {
        continue;
      }

      const info = _getActivityTaskInfo(task);
      if (info && info.speechHandle && blockedHandles.includes(info.speechHandle)) {
        continue;
      }

      toWait.push(task);
    }
    return toWait;
  }

  private wakeupMainTask(): void {
    this.q_updated.resolve();
  }

  generateReply(options: {
    userMessage?: ChatMessage;
    chatCtx?: ChatContext;
    instructions?: string | Instructions;
    toolChoice?: ToolChoice | null;
    allowInterruptions?: boolean;
    scheduleSpeech?: boolean;
    inputDetails?: InputDetails;
  }): SpeechHandle {
    const {
      userMessage,
      chatCtx,
      instructions: defaultInstructions,
      toolChoice: defaultToolChoice,
      allowInterruptions: defaultAllowInterruptions,
      scheduleSpeech = true,
      inputDetails,
    } = options;

    let instructions: string | Instructions | undefined = defaultInstructions;
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

    if (toolChoice === undefined) {
      // Default to 'none' when generateReply runs inside a tool on this activity.
      // Uses per-activity task info, not functionCallStorage: the latter is
      // AsyncLocalStorage and leaks the parent's function-call context into child
      // sessions spawned inside a tool (e.g. WarmTransferTask's supervisor session).
      const currentTask = Task.current();
      const taskInfo = currentTask ? _getActivityTaskInfo(currentTask) : undefined;
      if (taskInfo?.functionCall) {
        toolChoice = 'none';
      }
    }

    const handle = SpeechHandle.create({
      allowInterruptions: allowInterruptions ?? this.allowInterruptions,
      inputDetails,
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
        taskFn: (abortController: AbortController) =>
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
        ownedSpeechHandle: handle,
        name: 'AgentActivity.realtimeReply',
      });
    } else if (this.llm instanceof LLM) {
      // instructions used inside generateReply are "extra" instructions.
      // this matches the behavior of the Realtime API:
      // https://platform.openai.com/docs/api-reference/realtime-client-events/response/create
      if (instructions) {
        instructions = concatInstructions(this.agent.instructions, '\n', instructions);
      }

      // Filter out tools with IGNORE_ON_ENTER flag when generateReply is called inside onEnter
      const onEnterData = onEnterStorage.getStore();
      const shouldFilterTools =
        onEnterData?.agent === this.agent && onEnterData?.session === this.agentSession;

      const tools = shouldFilterTools
        ? Object.fromEntries(
            Object.entries(this.agent.toolCtx).filter(
              ([, fnTool]) => !(fnTool.flags & ToolFlag.IGNORE_ON_ENTER),
            ),
          )
        : this.agent.toolCtx;

      const task = this.createSpeechTask({
        taskFn: (abortController: AbortController) =>
          this.pipelineReplyTask(
            handle,
            chatCtx ?? this.agent.chatCtx,
            tools,
            {
              toolChoice: toOaiToolChoice(toolChoice !== undefined ? toolChoice : this.toolChoice),
            },
            abortController,
            instructions,
            userMessage,
          ),
        ownedSpeechHandle: handle,
        name: 'AgentActivity.pipelineReply',
      });

      task.result.finally(() => this.onPipelineReplyDone());
    }

    if (scheduleSpeech) {
      this.scheduleSpeech(handle, SpeechHandle.SPEECH_PRIORITY_NORMAL);
    }
    return handle;
  }

  interrupt(options: { force?: boolean } = {}): Future<void> {
    const { force = false } = options;
    this.cancelPreemptiveGeneration();

    const future = new Future<void>();
    const currentSpeech = this._currentSpeech;

    this._interruptBackgroundSpeeches(force);

    currentSpeech?.interrupt(force);

    for (const [_, __, speech] of this.speechQueue) {
      speech.interrupt(force);
    }

    this.realtimeSession?.interrupt();

    if (force) {
      // Force-interrupt (used during shutdown): cancel all speech tasks so they
      // don't block on I/O that will never complete (e.g. audioOutput.waitForPlayout()
      // when the room is disconnected). Mark the current speech as done immediately
      // so the interrupt future resolves without waiting for tasks to finish.
      // Clear the queue so mainTask doesn't dequeue already-interrupted handles
      // and hang on _waitForGeneration() (the generation future created by
      // _authorizeGeneration would never resolve since _markDone is a no-op
      // once doneFut is already settled).
      for (const task of this.speechTasks) {
        task.cancel();
      }
      if (currentSpeech && !currentSpeech.done()) {
        currentSpeech._markDone();
      }
      this.speechQueue.clear();
      future.resolve();
    } else if (currentSpeech === undefined) {
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
      if (this.audioRecognition) {
        this.audioRecognition.onEndOfAgentSpeech(Date.now());
      }
      if (this.isInterruptionDetectionEnabled) {
        this.restoreInterruptionByAudioActivity();
      }
    }
  }

  /**
   * Commit a user turn whose reply is being skipped: append the transcript to the
   * agent chat context (when non-empty) without triggering reply generation.
   * Mirrors the python `_on_user_turn_completed` `skip_reply` branch.
   */
  private commitSkippedUserTurn(info: EndOfTurnInfo): void {
    if (info.newTranscript === '') {
      return;
    }
    const userMessage = ChatMessage.create({
      role: 'user',
      content: info.newTranscript,
      transcriptConfidence: info.transcriptConfidence,
    });
    this.agent._chatCtx.items.push(userMessage);
    this.agentSession._conversationItemAdded(userMessage);
  }

  private async userTurnCompleted(info: EndOfTurnInfo, oldTask?: Task<void>): Promise<void> {
    if (oldTask) {
      // We never cancel user code as this is very confusing.
      // So we wait for the old execution of onUserTurnCompleted to finish.
      // In practice this is OK because most speeches will be interrupted if a new turn
      // is detected. So the previous execution should complete quickly.
      await oldTask.result;
    }

    this._preemptiveGenerationCount = 0;

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
      if (this.realtimeSession) {
        if (info.skipReply) {
          this.commitSkippedUserTurn(info);
          return;
        }
        this.realtimeSession.commitAudio();
      }
    }

    // The reply is being driven elsewhere (e.g. AMD leaving a voicemail). Commit the
    // user turn to chat context but don't generate or interrupt anything.
    if (info.skipReply) {
      this.commitSkippedUserTurn(info);
      return;
    }

    // Capture into a local before awaiting cancelSpeechPause: the main scheduling
    // loop can reset this._currentSpeech = undefined during the await (#1430).
    const currentSpeech = this._currentSpeech;
    if (currentSpeech) {
      if (!currentSpeech.allowInterruptions) {
        this.logger.warn(
          { user_input: info.newTranscript },
          'skipping user input, current speech generation cannot be interrupted',
        );
        return;
      }

      await this.cancelSpeechPause();

      this.logger.info(
        { 'speech id': currentSpeech.id },
        'speech interrupted, new user turn detected',
      );

      currentSpeech.interrupt();
      this.realtimeSession?.interrupt();
    }

    let userMessage: ChatMessage | undefined = ChatMessage.create({
      role: 'user',
      content: info.newTranscript,
      transcriptConfidence: info.transcriptConfidence,
    });

    if (this.schedulingPaused || this.newTurnsBlocked) {
      this.logger.warn(
        { user_input: info.newTranscript },
        'skipping onUserTurnCompleted, speech scheduling is paused',
      );
      if (this.agentSession._closing) {
        this.agent._chatCtx.items.push(userMessage);
        this.agentSession._conversationItemAdded(userMessage);
      }
      return;
    }

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

    if (this.schedulingPaused || this.newTurnsBlocked) {
      this.logger.warn(
        { user_input: info.newTranscript },
        'skipping reply to user input, speech scheduling is paused',
      );
      if (userMessage && this.agentSession._closing) {
        this.agent._chatCtx.items.push(userMessage);
        this.agentSession._conversationItemAdded(userMessage);
      }
      return;
    }

    const userMetricsReport: MetricsReport = {};
    if (info.startedSpeakingAt !== undefined) {
      userMetricsReport.startedSpeakingAt = info.startedSpeakingAt / 1000; // ms -> seconds
    }
    if (info.stoppedSpeakingAt !== undefined) {
      userMetricsReport.stoppedSpeakingAt = info.stoppedSpeakingAt / 1000; // ms -> seconds
    }
    if (info.transcriptionDelay !== undefined) {
      userMetricsReport.transcriptionDelay = info.transcriptionDelay / 1000; // ms -> seconds
    }
    if (info.endOfUtteranceDelay !== undefined) {
      userMetricsReport.endOfTurnDelay = info.endOfUtteranceDelay / 1000; // ms -> seconds
    }
    userMetricsReport.onUserTurnCompletedDelay = callbackDuration / 1000; // ms -> seconds
    if (userMessage) {
      userMessage.metrics = userMetricsReport;
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
        // The preemptive userMessage was created without metrics.
        // Copy the metrics and transcriptConfidence from the new userMessage
        // to the preemptive message BEFORE scheduling (so the pipeline inserts
        // the message with metrics already set).
        if (preemptive.userMessage && userMessage) {
          preemptive.userMessage.metrics = userMetricsReport;
          preemptive.userMessage.transcriptConfidence = userMessage.transcriptConfidence;
        }
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
      speechHandle = this.generateReply({
        userMessage,
        chatCtx,
        inputDetails: { modality: 'audio' },
      });
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
    speechHandle._agentTurnContext = otelContext.active();

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

    let replyStartedSpeakingAt: number | undefined;
    let replyStartedForwardingAt: number | undefined;
    let replyTtsGenData: _TTSGenerationData | null = null;

    const onFirstFrame = (audioOut: _AudioOut | null, startedSpeakingAt: number = Date.now()) => {
      replyStartedSpeakingAt = startedSpeakingAt;
      replyStartedForwardingAt = audioOut?.startedForwardingAt ?? replyStartedSpeakingAt;
      this.agentSession._updateAgentState('speaking', {
        startTime: startedSpeakingAt,
        otelContext: speechHandle._agentTurnContext,
      });
      if (this.audioRecognition) {
        this.audioRecognition.onStartOfAgentSpeech(replyStartedSpeakingAt);
      }
      if (this.isInterruptionDetectionEnabled) {
        this.disableVadInterruptionSoon();
      }
    };

    if (!audioOutput) {
      if (textOut) {
        textOut.firstTextFut.await
          .then(() => onFirstFrame(null))
          .catch(() => this.logger.debug('firstTextFut cancelled before first frame'));
      }
    } else {
      let audioOut: _AudioOut | null = null;
      if (!audio) {
        // generate audio using TTS
        const [ttsTask, ttsGenData] = performTTSInference(
          (...args) => this.agent.ttsNode(...args),
          audioSource,
          modelSettings,
          replyAbortController,
          this.tts?.model,
          this.tts?.provider,
          this.agentSession.sessionOptions.ttsReadIdleTimeout,
          this.agentSession.sessionOptions.ttsTextTransforms,
        );
        tasks.push(ttsTask);
        replyTtsGenData = ttsGenData;

        const [forwardTask, _audioOut] = performAudioForwarding(
          ttsGenData.audioStream,
          audioOutput,
          replyAbortController,
          this.agentSession.sessionOptions.forwardAudioIdleTimeout,
        );
        tasks.push(forwardTask);
        audioOut = _audioOut;
      } else {
        // use the provided audio
        const [forwardTask, _audioOut] = performAudioForwarding(
          audio,
          audioOutput,
          replyAbortController,
          this.agentSession.sessionOptions.forwardAudioIdleTimeout,
        );
        tasks.push(forwardTask);
        audioOut = _audioOut;
      }
      const audioOutForCb = audioOut;
      audioOut.firstFrameFut.await
        .then((ts) => onFirstFrame(audioOutForCb, ts))
        .catch(() => this.logger.debug('firstFrameFut cancelled before first frame'));
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
      const replyStoppedSpeakingAt = Date.now();
      const replyAssistantMetrics: MetricsReport = {};
      if (replyTtsGenData?.ttfb !== undefined) {
        replyAssistantMetrics.ttsNodeTtfb = replyTtsGenData.ttfb;
      }
      if (replyStartedSpeakingAt !== undefined) {
        replyAssistantMetrics.startedSpeakingAt = replyStartedSpeakingAt / 1000; // ms -> seconds
        replyAssistantMetrics.stoppedSpeakingAt = replyStoppedSpeakingAt / 1000; // ms -> seconds

        if (replyStartedForwardingAt !== undefined) {
          replyAssistantMetrics.playbackLatency =
            (replyStartedSpeakingAt - replyStartedForwardingAt) / 1000; // ms -> seconds
        }
      }

      const message = ChatMessage.create({
        role: 'assistant',
        content: textOut?.text || '',
        interrupted: speechHandle.interrupted,
        metrics: replyAssistantMetrics,
      });
      this.agent._chatCtx.insert(message);
      this.agentSession._conversationItemAdded(message);
    }

    if (this.agentSession.agentState === 'speaking') {
      this.agentSession._updateAgentState('listening');
      if (this.audioRecognition) {
        this.audioRecognition.onEndOfAgentSpeech(Date.now());
      }
      this.restoreInterruptionByAudioActivity();
    }
  }

  private _pipelineReplyTaskImpl = async ({
    speechHandle,
    chatCtx,
    toolCtx,
    modelSettings,
    replyAbortController,
    instructions,
    newMessage,
    toolsMessages,
    span,
    _previousUserMetrics,
  }: {
    speechHandle: SpeechHandle;
    chatCtx: ChatContext;
    toolCtx: ToolContext;
    modelSettings: ModelSettings;
    replyAbortController: AbortController;
    instructions?: string | Instructions;
    newMessage?: ChatMessage;
    toolsMessages?: ChatItem[];
    span: Span;
    _previousUserMetrics?: MetricsReport;
  }): Promise<void> => {
    speechHandle._agentTurnContext = otelContext.active();

    span.setAttribute(traceTypes.ATTR_SPEECH_ID, speechHandle.id);
    if (instructions) {
      span.setAttribute(traceTypes.ATTR_INSTRUCTIONS, renderInstructions(instructions));
    }
    if (newMessage) {
      span.setAttribute(traceTypes.ATTR_USER_INPUT, newMessage.textContent || '');
    }

    const localParticipant = this.agentSession._roomIO?.localParticipant;
    if (localParticipant) {
      setParticipantSpanAttributes(span, localParticipant);
    }

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

    // apply the correct variant of the instructions for the turn's input modality
    applyInstructionsModality(chatCtx, { modality: speechHandle.inputDetails.modality });

    const tasks: Array<Task<void>> = [];
    const [llmTask, llmGenData] = performLLMInference(
      // preserve  `this` context in llmNode
      (...args) => this.agent.llmNode(...args),
      chatCtx,
      toolCtx,
      modelSettings,
      replyAbortController,
      this.llm?.model,
      this.llm?.provider,
    );
    tasks.push(llmTask);

    interface SpeechSegment {
      textStream: ReadableStream<string>;
      textWriter: WritableStreamDefaultWriter<string>;
      ttsTextWriter?: WritableStreamDefaultWriter<string>;
      ttsTask?: Task<void>;
      ttsGenData?: _TTSGenerationData;
    }

    interface SegmentOutput {
      textOut: _TextOut | null;
      audioOut: _AudioOut | null;
      played: 'full' | 'partial' | 'skipped';
      playbackPositionInS: number;
      synchronizedTranscript?: string;
    }

    const forwardedTextFor = (output: SegmentOutput): string => {
      if (output.played === 'skipped') return '';
      if (output.played === 'partial' && output.audioOut) {
        return output.synchronizedTranscript ?? '';
      }
      return output.textOut?.text ?? '';
    };

    const segmentQueue = new AsyncIterableQueue<SpeechSegment>();
    let synthesizeTask: Task<void> | null = null;

    const produceSegments = async (controller: AbortController): Promise<void> => {
      const reader = llmGenData.textStream.getReader();
      let current: SpeechSegment | null = null;
      let prevTtsTask: Task<void> | null = null;

      const startSegment = async (): Promise<SpeechSegment> => {
        if (prevTtsTask) {
          await prevTtsTask.result;
        }

        const textStream = new IdentityTransform<string>();
        const segment: SpeechSegment = {
          textStream: textStream.readable,
          textWriter: textStream.writable.getWriter(),
        };

        if (audioOutput) {
          const ttsInput = new IdentityTransform<string>();
          const [ttsTask, ttsGenData] = performTTSInference(
            (...args) => this.agent.ttsNode(...args),
            ttsInput.readable,
            modelSettings,
            replyAbortController,
            this.tts?.model,
            this.tts?.provider,
            this.agentSession.sessionOptions.ttsReadIdleTimeout,
            this.agentSession.sessionOptions.ttsTextTransforms,
          );
          tasks.push(ttsTask);
          prevTtsTask = ttsTask;
          segment.ttsTextWriter = ttsInput.writable.getWriter();
          segment.ttsTask = ttsTask;
          segment.ttsGenData = ttsGenData;
        }

        segmentQueue.put(segment);
        return segment;
      };

      const endSegment = async () => {
        if (!current) return;
        await current.textWriter.close();
        await current.ttsTextWriter?.close();
        current = null;
      };

      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          if (isFlushSentinel(value)) {
            await endSegment();
            continue;
          }

          if (current === null) {
            current = await startSegment();
          }
          await current.textWriter.write(value);
          await current.ttsTextWriter?.write(value);
        }
      } finally {
        await endSegment();
        segmentQueue.close();
        reader.releaseLock();
      }
    };

    // Start preemptive synthesis if enabled. Otherwise it starts after scheduling below.
    const preemptiveOpts = this.agentSession.sessionOptions.turnHandling.preemptiveGeneration;
    if (audioOutput && preemptiveOpts.enabled && preemptiveOpts.preemptiveTts) {
      synthesizeTask = Task.from(
        (controller) => produceSegments(controller),
        replyAbortController,
        'AgentActivity.pipelineReply.produceSegments',
      );
      tasks.push(synthesizeTask);
    }

    await speechHandle.waitIfNotInterrupted([speechHandle._waitForScheduled()]);

    let userMetrics: MetricsReport | undefined = _previousUserMetrics;
    // Add new message to actual chat context if the speech is scheduled
    if (newMessage && speechHandle.scheduled) {
      this.agent._chatCtx.insert(newMessage);
      this.agentSession._conversationItemAdded(newMessage);
      userMetrics = newMessage.metrics;
    }

    if (speechHandle.interrupted) {
      replyAbortController.abort();
      await cancelAndWait(tasks, AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
      return;
    }

    if (synthesizeTask === null) {
      synthesizeTask = Task.from(
        (controller) => produceSegments(controller),
        replyAbortController,
        'AgentActivity.pipelineReply.produceSegments',
      );
      tasks.push(synthesizeTask);
    }

    this.agentSession._updateAgentState('thinking');

    await speechHandle.waitIfNotInterrupted([speechHandle._waitForAuthorization()]);
    speechHandle._clearAuthorization();

    const replyStartedAt = Date.now();

    let agentStartedSpeakingAt: number | undefined;
    let agentStartedForwardingAt: number | undefined;
    let firstTtsGenData: _TTSGenerationData | null = null;
    const onFirstFrame = (
      audioOutRef: _AudioOut | null,
      startedSpeakingAt: number = Date.now(),
    ) => {
      if (agentStartedSpeakingAt !== undefined) return;
      agentStartedSpeakingAt = startedSpeakingAt;
      agentStartedForwardingAt = audioOutRef?.startedForwardingAt ?? agentStartedSpeakingAt;
      this.agentSession._updateAgentState('speaking', {
        startTime: startedSpeakingAt,
        otelContext: speechHandle._agentTurnContext,
      });
      if (this.audioRecognition) {
        this.audioRecognition.onStartOfAgentSpeech(agentStartedSpeakingAt);
      }
      if (this.isInterruptionDetectionEnabled) {
        this.disableVadInterruptionSoon();
      }
    };

    const useAlignedTranscript = Boolean(
      audioOutput && this.useTtsAlignedTranscript && this.tts?.capabilities.alignedTranscript,
    );

    const forwardSegment = async (segment: SpeechSegment): Promise<SegmentOutput> => {
      const output: SegmentOutput = {
        textOut: null,
        audioOut: null,
        played: 'skipped',
        playbackPositionInS: 0,
      };
      const segmentAbortController = new AbortController();
      const abortSegment = () => segmentAbortController.abort();
      replyAbortController.signal.addEventListener('abort', abortSegment, { once: true });
      const forwardTasks: Task<void>[] = [];

      try {
        let transcriptionInput: ReadableStream<string | TimedString> = segment.textStream;
        if (useAlignedTranscript && segment.ttsGenData && segment.ttsTask) {
          const timedTextsStream = await ThrowsPromise.race([
            segment.ttsGenData.timedTextsFut.await,
            segment.ttsTask.result.catch(() =>
              this.logger.warn('TTS task failed before resolving timedTextsFut'),
            ),
          ]);
          if (timedTextsStream) {
            this.logger.debug('Using TTS aligned transcripts for transcription node input');
            transcriptionInput = timedTextsStream;
          }
        }

        const trNodeResult = await this.agent.transcriptionNode(transcriptionInput, modelSettings);
        if (trNodeResult) {
          const [textForwardTask, textOut] = performTextForwarding(
            trNodeResult,
            segmentAbortController,
            transcriptionOutput,
          );
          forwardTasks.push(textForwardTask);
          output.textOut = textOut;
        }

        if (audioOutput && segment.ttsGenData) {
          const [forwardTask, audioOut] = performAudioForwarding(
            segment.ttsGenData.audioStream,
            audioOutput,
            segmentAbortController,
            this.agentSession.sessionOptions.forwardAudioIdleTimeout,
          );
          forwardTasks.push(forwardTask);
          output.audioOut = audioOut;
          audioOut.firstFrameFut.await
            .then((ts) => onFirstFrame(audioOut, ts))
            .catch(() => this.logger.debug('firstFrameFut cancelled before first frame'));
        } else if (output.textOut) {
          output.textOut.firstTextFut.await
            .then(() => onFirstFrame(null))
            .catch(() => this.logger.debug('firstTextFut cancelled before first frame'));
        }

        await speechHandle.waitIfNotInterrupted(forwardTasks.map((task) => task.result));
        let playbackEv: PlaybackFinishedEvent | undefined;
        if (!speechHandle.interrupted && audioOutput) {
          const playoutPromise = audioOutput.waitForPlayout();
          await speechHandle.waitIfNotInterrupted([playoutPromise]);
          if (!speechHandle.interrupted) {
            playbackEv = await playoutPromise;
          }
        }

        if (speechHandle.interrupted) {
          await cancelAndWait(forwardTasks, AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
          if (audioOutput) {
            audioOutput.clearBuffer();
            const interruptedPlaybackEv = await audioOutput.waitForPlayout();
            if (output.audioOut?.firstFrameFut.done && !output.audioOut.firstFrameFut.rejected) {
              output.played = 'partial';
              output.playbackPositionInS = interruptedPlaybackEv.playbackPosition;
              output.synchronizedTranscript = interruptedPlaybackEv.synchronizedTranscript;
            }
          } else if (output.textOut?.text) {
            output.played = 'partial';
          }
          return output;
        }

        if (audioOutput && playbackEv) {
          output.played = 'full';
          output.playbackPositionInS = playbackEv.playbackPosition;
          output.synchronizedTranscript = playbackEv.synchronizedTranscript;
        } else if (output.textOut?.text) {
          output.played = 'full';
        }
        return output;
      } finally {
        replyAbortController.signal.removeEventListener('abort', abortSegment);
        await cancelAndWait(forwardTasks, AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
      }
    };

    //TODO(AJS-272): before executing tools, make sure we generated all the text
    // (this ensure everything is kept ordered)

    const onToolExecutionStarted = (f: FunctionCall) => {
      speechHandle._itemAdded([f]);
      this.agent._chatCtx.items.push(f);
      this.agentSession._toolItemsAdded([f]);
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
      toolChoice: modelSettings.toolChoice,
      toolCallStream: llmGenData.toolCallStream,
      controller: replyAbortController,
      onToolExecutionStarted,
      onToolExecutionCompleted,
    });

    const segmentOutputs: SegmentOutput[] = [];

    while (!speechHandle.interrupted) {
      const nextSegment = segmentQueue.next();
      await speechHandle.waitIfNotInterrupted([nextSegment]);
      if (speechHandle.interrupted) break;

      const { done, value: segment } = await nextSegment;
      if (done) break;

      if (firstTtsGenData === null && segment.ttsGenData) {
        firstTtsGenData = segment.ttsGenData;
      }

      const output = await forwardSegment(segment);
      segmentOutputs.push(output);
      if (output.played === 'partial') break;
    }

    const agentStoppedSpeakingAt = Date.now();
    const assistantMetrics: MetricsReport = {};

    if (llmGenData.ttft !== undefined) {
      assistantMetrics.llmNodeTtft = llmGenData.ttft; // already in seconds
    }
    if (firstTtsGenData?.ttfb !== undefined) {
      assistantMetrics.ttsNodeTtfb = firstTtsGenData.ttfb; // already in seconds
    }
    if (agentStartedSpeakingAt !== undefined) {
      assistantMetrics.startedSpeakingAt = agentStartedSpeakingAt / 1000; // ms -> seconds
      assistantMetrics.stoppedSpeakingAt = agentStoppedSpeakingAt / 1000; // ms -> seconds

      if (agentStartedForwardingAt !== undefined) {
        assistantMetrics.playbackLatency =
          (agentStartedSpeakingAt - agentStartedForwardingAt) / 1000; // ms -> seconds
      }

      if (userMetrics?.stoppedSpeakingAt !== undefined) {
        const e2eLatency = agentStartedSpeakingAt / 1000 - userMetrics.stoppedSpeakingAt;
        assistantMetrics.e2eLatency = e2eLatency;
        span.setAttribute(traceTypes.ATTR_E2E_LATENCY, e2eLatency);
      }
    }

    span.setAttribute(traceTypes.ATTR_SPEECH_INTERRUPTED, speechHandle.interrupted);
    let hasSpeechMessage = false;

    // add the tools messages that triggers this reply to the chat context
    if (toolsMessages) {
      for (const msg of toolsMessages) {
        msg.createdAt = replyStartedAt;
      }
      // Only insert FunctionCallOutput items into agent._chatCtx since FunctionCall items
      // were already added by onToolExecutionStarted when the tool execution began.
      // Inserting function_calls again would create duplicates that break provider APIs
      // (e.g. Google's "function response parts != function call parts" error).
      const toolCallOutputs = toolsMessages.filter(
        (m): m is FunctionCallOutput => m.type === 'function_call_output',
      );
      if (toolCallOutputs.length > 0) {
        this.agent._chatCtx.insert(toolCallOutputs);
        this.agentSession._toolItemsAdded(toolCallOutputs);
      }
    }

    if (speechHandle.interrupted) {
      this.logger.debug(
        { speech_id: speechHandle.id },
        'Aborting all pipeline reply tasks due to interruption',
      );

      replyAbortController.abort();
      await cancelAndWait(tasks, AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);

      const forwardedText = segmentOutputs.map(forwardedTextFor).join('');

      if (forwardedText) {
        hasSpeechMessage = true;
        const message = ChatMessage.create({
          role: 'assistant',
          content: forwardedText,
          id: llmGenData.id,
          interrupted: true,
          createdAt: replyStartedAt,
          metrics: assistantMetrics,
          ...(Object.keys(llmGenData.generatedExtra).length > 0
            ? { extra: llmGenData.generatedExtra }
            : {}),
        });
        chatCtx.insert(message);
        this.agent._chatCtx.insert(message);
        speechHandle._itemAdded([message]);
        this.agentSession._conversationItemAdded(message);
        span.setAttribute(traceTypes.ATTR_RESPONSE_TEXT, forwardedText);
      }

      if (this.agentSession.agentState === 'speaking') {
        this.agentSession._updateAgentState('listening');
        if (this.audioRecognition) {
          this.audioRecognition.onEndOfAgentSpeech(Date.now());
        }
        if (this.isInterruptionDetectionEnabled) {
          this.restoreInterruptionByAudioActivity();
        }
      }

      this.logger.info(
        { speech_id: speechHandle.id, message: forwardedText },
        'playout completed with interrupt',
      );
      if (speechHandle._hasGenerations) {
        speechHandle._markGenerationDone();
      }
      await executeToolsTask.cancelAndWait(AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
      return;
    }

    const forwardedText = segmentOutputs.map(forwardedTextFor).join('');
    if (forwardedText) {
      hasSpeechMessage = true;
      const message = ChatMessage.create({
        role: 'assistant',
        id: llmGenData.id,
        interrupted: false,
        createdAt: replyStartedAt,
        content: forwardedText,
        metrics: assistantMetrics,
        ...(Object.keys(llmGenData.generatedExtra).length > 0
          ? { extra: llmGenData.generatedExtra }
          : {}),
      });
      chatCtx.insert(message);
      this.agent._chatCtx.insert(message);
      speechHandle._itemAdded([message]);
      this.agentSession._conversationItemAdded(message);
      span.setAttribute(traceTypes.ATTR_RESPONSE_TEXT, forwardedText);
      this.logger.info(
        { speech_id: speechHandle.id, message: forwardedText },
        'playout completed without interruption',
      );
    }

    if (!speechHandle.interrupted && toolOutput.output.length > 0) {
      this.agentSession._updateAgentState('thinking');
    } else if (this.agentSession.agentState === 'speaking') {
      this.agentSession._updateAgentState('listening');
      if (this.audioRecognition) {
        this.audioRecognition.onEndOfAgentSpeech(Date.now());
      }
      if (this.isInterruptionDetectionEnabled) {
        this.restoreInterruptionByAudioActivity();
      }
    }

    // mark the playout done before waiting for the tool execution
    if (speechHandle._hasGenerations) {
      speechHandle._markGenerationDone();
    }

    if (speechHandle.interrupted) {
      await executeToolsTask.cancelAndWait(AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
      return;
    }

    this._backgroundSpeeches.add(speechHandle);
    try {
      await executeToolsTask.result;
    } finally {
      this._backgroundSpeeches.delete(speechHandle);
    }

    if (toolOutput.output.length === 0) return;

    // important: no agent output should be used after this point
    const { maxToolSteps } = this.agentSession.sessionOptions;
    if (speechHandle.numSteps >= maxToolSteps) {
      this.logger.warn(
        { speech_id: speechHandle.id, max_tool_steps: maxToolSteps },
        'maximum number of function calls steps reached',
      );
      return;
    }

    const { functionToolsExecutedEvent, shouldGenerateToolReply, newAgentTask, ignoreTaskSwitch } =
      this.summarizeToolExecutionOutput(toolOutput, speechHandle);

    this.agentSession.emit(
      AgentSessionEventTypes.FunctionToolsExecuted,
      functionToolsExecutedEvent,
    );

    let schedulingPaused = this.schedulingPaused;
    if (!ignoreTaskSwitch && newAgentTask !== null) {
      this.agentSession.updateAgent(newAgentTask);
      schedulingPaused = true;
    }

    const toolMessages = [
      ...functionToolsExecutedEvent.functionCalls,
      ...functionToolsExecutedEvent.functionCallOutputs,
    ] as ChatItem[];
    if (shouldGenerateToolReply) {
      chatCtx.insert(toolMessages);

      // Increment step count on SAME handle (parity with Python agent_activity.py L2081)
      speechHandle._numSteps += 1;

      // Avoid setting tool_choice to "required" or a specific function when
      // passing tool response back to the LLM
      const respondToolChoice =
        schedulingPaused || modelSettings.toolChoice === 'none' ? 'none' : 'auto';

      // Reuse same speechHandle for tool response (parity with Python agent_activity.py L2122-2140)
      const toolResponseTask = this.createSpeechTask({
        taskFn: () =>
          this.pipelineReplyTask(
            speechHandle,
            chatCtx,
            toolCtx,
            { toolChoice: respondToolChoice },
            replyAbortController,
            instructions,
            undefined,
            toolMessages,
            hasSpeechMessage ? undefined : userMetrics,
          ),
        ownedSpeechHandle: speechHandle,
        name: 'AgentActivity.pipelineReply',
      });

      toolResponseTask.result.finally(() => this.onPipelineReplyDone());

      this.scheduleSpeech(speechHandle, SpeechHandle.SPEECH_PRIORITY_NORMAL, true);
    } else if (functionToolsExecutedEvent.functionCallOutputs.length > 0) {
      for (const msg of toolMessages) {
        msg.createdAt = replyStartedAt;
      }

      const toolCallOutputs = toolMessages.filter(
        (m): m is FunctionCallOutput => m.type === 'function_call_output',
      );

      if (toolCallOutputs.length > 0) {
        this.agent._chatCtx.insert(toolCallOutputs);
        this.agentSession._toolItemsAdded(toolCallOutputs);
      }
    }
  };

  private pipelineReplyTask = async (
    speechHandle: SpeechHandle,
    chatCtx: ChatContext,
    toolCtx: ToolContext,
    modelSettings: ModelSettings,
    replyAbortController: AbortController,
    instructions?: string | Instructions,
    newMessage?: ChatMessage,
    toolsMessages?: ChatItem[],
    _previousUserMetrics?: MetricsReport,
  ): Promise<void> =>
    tracer.startActiveSpan(
      async (span) =>
        this._pipelineReplyTaskImpl({
          speechHandle,
          chatCtx,
          toolCtx,
          modelSettings,
          replyAbortController,
          instructions,
          newMessage,
          toolsMessages,
          span,
          _previousUserMetrics,
        }),
      {
        name: 'agent_turn',
        context: this.agentSession.rootSpanContext,
      },
    );

  private async realtimeGenerationTask(
    speechHandle: SpeechHandle,
    ev: GenerationCreatedEvent,
    modelSettings: ModelSettings,
    replyAbortController: AbortController,
    addToChatCtx: boolean = true,
  ): Promise<void> {
    return tracer.startActiveSpan(
      async (span) =>
        this._realtimeGenerationTaskImpl({
          speechHandle,
          ev,
          modelSettings,
          replyAbortController,
          addToChatCtx,
          span,
        }),
      {
        name: 'agent_turn',
        context: this.agentSession.rootSpanContext,
      },
    );
  }

  private async _realtimeGenerationTaskImpl({
    speechHandle,
    ev,
    modelSettings,
    replyAbortController,
    addToChatCtx,
    span,
  }: {
    speechHandle: SpeechHandle;
    ev: GenerationCreatedEvent;
    modelSettings: ModelSettings;
    replyAbortController: AbortController;
    addToChatCtx: boolean;
    span: Span;
  }): Promise<void> {
    speechHandle._agentTurnContext = otelContext.active();

    span.setAttribute(traceTypes.ATTR_SPEECH_ID, speechHandle.id);

    const localParticipant = this.agentSession._roomIO?.localParticipant;
    if (localParticipant) {
      setParticipantSpanAttributes(span, localParticipant);
    }

    speechHandleStorage.enterWith(speechHandle);

    const realtimeSession = this.realtimeSession;
    const realtimeModel = this.llm;
    if (!realtimeSession) {
      throw new Error('realtime session is not initialized');
    }
    if (!(realtimeModel instanceof RealtimeModel)) {
      throw new Error('llm is not a realtime model');
    }

    // Store span for metrics recording when they arrive later
    span.setAttribute(traceTypes.ATTR_GEN_AI_REQUEST_MODEL, realtimeModel.model);
    if (this.realtimeSpans && ev.responseId) {
      this.realtimeSpans.set(ev.responseId, span);
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
    const toolCtx = realtimeSession.tools;

    await speechHandle.waitIfNotInterrupted([speechHandle._waitForAuthorization()]);
    speechHandle._clearAuthorization();

    if (speechHandle.interrupted) {
      return;
    }

    let startedSpeakingAt: number | undefined;
    const onFirstFrame = (startedAt: number = Date.now()) => {
      if (startedSpeakingAt !== undefined) return;
      startedSpeakingAt = startedAt;
      this.agentSession._updateAgentState('speaking', {
        startTime: startedAt,
        otelContext: speechHandle._agentTurnContext,
      });
      if (this.audioRecognition) {
        this.audioRecognition.onStartOfAgentSpeech(startedAt);
      }
    };

    interface MessageOutput {
      message: MessageGeneration;
      textOut: _TextOut | null;
      audioOut: _AudioOut | null;
      modalities?: ('text' | 'audio')[];
      played: 'full' | 'partial' | 'skipped';
      playbackPositionInS: number;
      synchronizedTranscript?: string;
    }

    const tasks: Array<Task<void>> = [];

    const processOneMessage = async (
      msg: MessageGeneration,
      abortController: AbortController,
    ): Promise<MessageOutput> => {
      const messageAbortController = new AbortController();
      const abortMessage = () => messageAbortController.abort();
      abortController.signal.addEventListener('abort', abortMessage, { once: true });
      const output: MessageOutput = {
        message: msg,
        textOut: null,
        audioOut: null,
        modalities: undefined,
        played: 'skipped',
        playbackPositionInS: 0,
      };

      const forwardTasks: Array<Task<void>> = [];
      try {
        const msgModalities = msg.modalities ? await msg.modalities : undefined;
        output.modalities = msgModalities;
        let ttsTextInput: ReadableStream<string | TimedString> | null = null;
        let trTextInput: ReadableStream<string | TimedString>;

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

        if (audioOutput) {
          let realtimeAudioResult: ReadableStream<AudioFrame> | null = null;

          if (ttsTextInput) {
            const [ttsTask, ttsGenData] = performTTSInference(
              (...args) => this.agent.ttsNode(...args),
              ttsTextInput,
              modelSettings,
              messageAbortController,
              this.tts?.model,
              this.tts?.provider,
              this.agentSession.sessionOptions.ttsReadIdleTimeout,
              this.agentSession.sessionOptions.ttsTextTransforms,
            );
            tasks.push(ttsTask);
            realtimeAudioResult = ttsGenData.audioStream;
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
            const [forwardTask, audioOut] = performAudioForwarding(
              realtimeAudioResult,
              audioOutput,
              messageAbortController,
              this.agentSession.sessionOptions.forwardAudioIdleTimeout,
            );
            forwardTasks.push(forwardTask);
            output.audioOut = audioOut;
            audioOut.firstFrameFut.await
              .then((ts) => onFirstFrame(ts))
              .catch(() => this.logger.debug('firstFrameFut cancelled before first frame'));
          }
        }

        const trNodeResult = await this.agent.transcriptionNode(trTextInput, modelSettings);
        if (trNodeResult) {
          const [textForwardTask, textOut] = performTextForwarding(
            trNodeResult,
            messageAbortController,
            textOutput,
          );
          forwardTasks.push(textForwardTask);
          output.textOut = textOut;
        }

        if (!output.audioOut && output.textOut) {
          output.textOut.firstTextFut.await
            .then(() => onFirstFrame())
            .catch(() => this.logger.debug('firstTextFut cancelled before first frame'));
        }

        let playoutEv: PlaybackFinishedEvent | undefined;
        await speechHandle.waitIfNotInterrupted(forwardTasks.map((task) => task.result));
        if (!speechHandle.interrupted && audioOutput) {
          const playoutPromise = audioOutput.waitForPlayout();
          await speechHandle.waitIfNotInterrupted([playoutPromise]);
          if (!speechHandle.interrupted) {
            playoutEv = await playoutPromise;
          }
        }

        if (speechHandle.interrupted) {
          await cancelAndWait(forwardTasks, AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
          if (audioOutput) {
            audioOutput.clearBuffer();
            const playbackEv = await audioOutput.waitForPlayout();
            if (output.audioOut?.firstFrameFut.done && !output.audioOut.firstFrameFut.rejected) {
              output.played = 'partial';
              output.playbackPositionInS = playbackEv.playbackPosition;
              output.synchronizedTranscript = playbackEv.synchronizedTranscript;
            }
          } else if (output.textOut?.text) {
            output.played = 'partial';
          }
          return output;
        }

        if (audioOutput && playoutEv) {
          output.played = 'full';
          output.playbackPositionInS = playoutEv.playbackPosition;
          output.synchronizedTranscript = playoutEv.synchronizedTranscript;
        } else if (output.textOut?.text) {
          output.played = 'full';
        }
        return output;
      } finally {
        abortController.signal.removeEventListener('abort', abortMessage);
        await cancelAndWait(forwardTasks, AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
      }
    };

    const processMessages = async (abortController: AbortController, outputs: MessageOutput[]) => {
      replyAbortController.signal.addEventListener('abort', () => abortController.abort(), {
        once: true,
      });
      try {
        for await (const msg of ev.messageStream) {
          if (speechHandle.interrupted) {
            break;
          }
          const output = await processOneMessage(msg, abortController);
          outputs.push(output);
          if (output.played === 'partial') break;
        }
      } catch (error) {
        this.logger.error(error, 'error reading messages from the realtime API');
      }
    };

    const messageOutputs: MessageOutput[] = [];
    tasks.push(
      Task.from(
        (controller) => processMessages(controller, messageOutputs),
        undefined,
        'AgentActivity.realtime_generation.process_messages',
      ),
    );

    const addRealtimeMessageOutputs = (outputs: MessageOutput[]) => {
      const traceTextParts: string[] = [];
      for (const output of outputs) {
        if (output.played === 'skipped') continue;

        const interrupted = output.played === 'partial';
        let forwardedText = output.textOut?.text || '';
        if (interrupted && output.audioOut) {
          forwardedText = output.synchronizedTranscript ?? '';
        }

        if (interrupted && realtimeModel.capabilities.messageTruncation) {
          void realtimeSession.truncate({
            messageId: output.message.messageId,
            audioEndMs: Math.floor(output.playbackPositionInS * 1000),
            modalities: output.modalities,
            audioTranscript: forwardedText,
          });
        }

        if (!forwardedText) continue;

        traceTextParts.push(forwardedText);
        if (addToChatCtx) {
          const message = ChatMessage.create({
            role: 'assistant',
            content: forwardedText,
            id: output.message.messageId,
            interrupted,
            createdAt: startedSpeakingAt,
          });
          this.agent._chatCtx.insert(message);
          speechHandle._itemAdded([message]);
          this.agentSession._conversationItemAdded(message);
        }
      }

      if (traceTextParts.length > 0) {
        span.setAttribute(traceTypes.ATTR_RESPONSE_TEXT, traceTextParts.join('\n'));
      }
    };

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
      this.agent._chatCtx.items.push(f);
      this.agentSession._toolItemsAdded([f]);
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

    if (speechHandle.interrupted) {
      this.logger.debug(
        { speech_id: speechHandle.id },
        'Aborting all realtime generation tasks due to interruption',
      );
      replyAbortController.abort();
      await cancelAndWait(tasks, AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);
      addRealtimeMessageOutputs(messageOutputs);

      const anySkipped = messageOutputs.some((output) => output.played === 'skipped');
      if (anySkipped && realtimeModel.capabilities.midSessionChatCtxUpdate) {
        try {
          await realtimeSession.updateChatCtx(this.agent._chatCtx);
        } catch (error) {
          this.logger.warn(
            { error },
            'failed to sync chat context to remove never-played messages',
          );
        }
      }

      if (this.agentSession.agentState === 'speaking') {
        this.agentSession._updateAgentState('listening');
        if (this.audioRecognition) {
          this.audioRecognition.onEndOfAgentSpeech(Date.now());
        }
      }
      speechHandle._markGenerationDone();
      await executeToolsTask.cancelAndWait(AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);

      // TODO(brian): close tees
      return;
    }

    addRealtimeMessageOutputs(messageOutputs);

    // mark the playout done before waiting for the tool execution
    speechHandle._markGenerationDone();
    // TODO(brian): close tees

    this._backgroundSpeeches.add(speechHandle);
    try {
      await executeToolsTask.result;
    } finally {
      this._backgroundSpeeches.delete(speechHandle);
    }

    if (toolOutput.output.length > 0) {
      this.agentSession._updateAgentState('thinking');
    } else if (this.agentSession.agentState === 'speaking') {
      this.agentSession._updateAgentState('listening');
      if (this.audioRecognition) {
        this.audioRecognition.onEndOfAgentSpeech(Date.now());
      }
    }

    if (toolOutput.output.length === 0) {
      return;
    }

    // important: no agent ouput should be used after this point
    const { maxToolSteps } = this.agentSession.sessionOptions;
    if (speechHandle.numSteps >= maxToolSteps) {
      this.logger.warn(
        { speech_id: speechHandle.id, max_tool_steps: maxToolSteps },
        'maximum number of function calls steps reached',
      );
      return;
    }

    const { functionToolsExecutedEvent, shouldGenerateToolReply, newAgentTask, ignoreTaskSwitch } =
      this.summarizeToolExecutionOutput(toolOutput, speechHandle);

    this.agentSession.emit(
      AgentSessionEventTypes.FunctionToolsExecuted,
      functionToolsExecutedEvent,
    );

    let schedulingPaused = this.schedulingPaused;
    if (!ignoreTaskSwitch && newAgentTask !== null) {
      this.agentSession.updateAgent(newAgentTask);
      schedulingPaused = true;
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
          await new ThrowsPromise<void, never>((resolve) => setImmediate(resolve));
        }
      }
      const chatCtx = realtimeSession.chatCtx.copy();
      chatCtx.items.push(...functionToolsExecutedEvent.functionCallOutputs);

      this.agentSession._toolItemsAdded(
        functionToolsExecutedEvent.functionCallOutputs as FunctionCallOutput[],
      );

      // If the realtime model auto-generates the tool reply, install a
      // placeholder so the active RunResult waits for that reply.
      let fut: Future<void, never> | undefined;
      if (
        realtimeModel.capabilities.autoToolReplyGeneration &&
        shouldGenerateToolReply &&
        this.pendingAutoToolReplyFut === undefined
      ) {
        const runState = this.agentSession._globalRunState;
        if (runState && !runState.done()) {
          fut = new Future();
          this.pendingAutoToolReplyFut = fut;
          const llmLabel = realtimeModel.label();
          const waitTask = Task.from(
            async () => {
              try {
                await waitUntilTimeout(fut!.await, 5000);
              } catch (error) {
                if (error instanceof IdleTimeoutError) {
                  this.logger.warn(
                    { llm: llmLabel },
                    'timed out waiting for realtime auto tool reply',
                  );
                  return;
                }
                throw error;
              } finally {
                if (this.pendingAutoToolReplyFut === fut) {
                  this.pendingAutoToolReplyFut = undefined;
                }
              }
            },
            undefined,
            'AgentActivity.waitForAutoToolReply',
          );
          runState._watchHandle(waitTask);
        }
      }

      try {
        await realtimeSession.updateChatCtx(chatCtx);
      } catch (error) {
        this.logger.warn(
          { error },
          'failed to update chat context before generating the function calls results',
        );
        if (fut && !fut.done) {
          if (this.pendingAutoToolReplyFut === fut) {
            this.pendingAutoToolReplyFut = undefined;
          }
          fut.resolve();
        }
      }
    }

    // skip realtime reply if not required or auto-generated
    if (!shouldGenerateToolReply || realtimeModel.capabilities.autoToolReplyGeneration) {
      return;
    }

    realtimeSession.interrupt();

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

    const toolChoice = schedulingPaused || modelSettings.toolChoice === 'none' ? 'none' : 'auto';
    this.createSpeechTask({
      taskFn: (abortController: AbortController) =>
        this.realtimeReplyTask({
          speechHandle: replySpeechHandle,
          modelSettings: { toolChoice },
          abortController,
        }),
      ownedSpeechHandle: replySpeechHandle,
      name: 'AgentActivity.realtime_reply',
    });

    this.scheduleSpeech(replySpeechHandle, SpeechHandle.SPEECH_PRIORITY_NORMAL, true);
  }

  private summarizeToolExecutionOutput(toolOutput: ToolOutput, speechHandle: SpeechHandle) {
    const functionToolsExecutedEvent = createFunctionToolsExecutedEvent({
      functionCalls: [],
      functionCallOutputs: [],
    });

    let shouldGenerateToolReply = false;
    let newAgentTask: Agent | null = null;
    let ignoreTaskSwitch = false;

    for (const sanitizedOut of toolOutput.output) {
      if (sanitizedOut.toolCallOutput !== undefined) {
        // Keep event payload symmetric for pipeline + realtime paths.
        functionToolsExecutedEvent.functionCalls.push(sanitizedOut.toolCall);
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

    return {
      functionToolsExecutedEvent,
      shouldGenerateToolReply,
      newAgentTask,
      ignoreTaskSwitch,
    };
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
    instructions?: string | Instructions;
  }): Promise<void> {
    speechHandleStorage.enterWith(speechHandle);

    if (!this.realtimeSession) {
      throw new Error('realtime session is not available');
    }

    await speechHandle.waitIfNotInterrupted([speechHandle._waitForAuthorization()]);
    if (speechHandle.interrupted) {
      return;
    }

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
      const generateReplyAbortController = new AbortController();
      const generationPromise = this.realtimeSession.generateReply(
        instructions !== undefined
          ? renderInstructions(instructions, speechHandle.inputDetails.modality)
          : undefined,
        { signal: generateReplyAbortController.signal },
      );
      void generationPromise.catch(() => undefined);

      await speechHandle.waitIfNotInterrupted([generationPromise]);
      if (speechHandle.interrupted) {
        generateReplyAbortController.abort();
        return;
      }

      const generationEvent = await generationPromise;
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
    // when force=true, we allow tool responses to bypass scheduling pause
    // This allows for tool responses to be generated before the AgentActivity is finalized
    if (this.schedulingPaused && !force) {
      throw new SchedulingPausedError();
    }

    // Monotonic time to avoid near 0 collisions
    this.speechQueue.push([priority, Number(process.hrtime.bigint()), speechHandle]);
    speechHandle._markScheduled();
    this.wakeupMainTask();
  }

  private async _pauseSchedulingTask(blockedTasks: Task<any>[]): Promise<void> {
    if (this._schedulingPaused) return;

    this._schedulingPaused = true;
    this._drainBlockedTasks = blockedTasks;
    this.wakeupMainTask();

    if (this._mainTask) {
      // Drain deadlock guard. A resume-triggered drain can run from inside one of
      // this activity's own speech tasks; awaiting _mainTask.result there is a
      // self-await because mainTask cannot exit until that same speech task
      // de-registers from speechTasks. A barge-in cascade can also leave mainTask
      // held only by already-done or interrupted "zombie" speech tasks. In both
      // cases, skip the await; close()/cancelAndWait still reaps mainTask.
      const currentTask = Task.current();
      const reentrant = !!currentTask && this.speechTasks.has(currentTask as Task<void>);
      const pending = this.getDrainPendingSpeechTasks();
      const allZombie =
        pending.length > 0 &&
        pending.every((task) => {
          if (task.done) return true;
          const info = _getActivityTaskInfo(task);
          return !!info?.speechHandle?.interrupted;
        });

      if (reentrant || allZombie) {
        this.logger.debug(
          { reentrant, allZombie, pending: pending.map((task) => task.name) },
          'skipping mainTask self-await during drain to avoid a deadlock',
        );
        return;
      }

      // When pausing/draining, we ensure that all speech_tasks complete fully.
      // This means that even if the SpeechHandle themselves have finished,
      // we still wait for the entire execution (e.g function_tools)
      await this._mainTask.result;
    }
  }

  private _resumeSchedulingTask(): void {
    if (!this._schedulingPaused) return;

    this._schedulingPaused = false;
    this.newTurnsBlocked = false;
    this._mainTask = Task.from(({ signal }) => this.mainTask(signal));
  }

  async pause(
    options: {
      blockedTasks?: Task<any>[];
      newActivity?: AgentActivity;
    } = {},
  ): Promise<ReusableResources | undefined> {
    const { blockedTasks = [], newActivity } = options;
    const unlock = await this.lock.lock();

    try {
      const span = tracer.startSpan({
        name: 'pause_agent_activity',
        attributes: { [traceTypes.ATTR_AGENT_LABEL]: this.agent.id },
      });

      let resources: ReusableResources | undefined;
      try {
        await this._pauseSchedulingTask(blockedTasks);

        // detach after speech tasks are done but before _closeSessionResources
        if (newActivity) {
          resources = await this._detachReusableResources(newActivity);
        }

        await this._closeSessionResources();
      } catch (error) {
        if (resources) {
          await cleanupReusableResources(resources, this.logger);
        }
        throw error;
      } finally {
        span.end();
      }

      return resources;
    } finally {
      unlock();
    }
  }

  async drain(options?: { newActivity?: AgentActivity }): Promise<ReusableResources | undefined> {
    // Create drain_agent_activity as a ROOT span (new trace) to match Python behavior
    return tracer.startActiveSpan(async (span) => this._drainImpl(span, options?.newActivity), {
      name: 'drain_agent_activity',
      context: ROOT_CONTEXT,
    });
  }

  private async _drainImpl(
    span: Span,
    newActivity?: AgentActivity,
  ): Promise<ReusableResources | undefined> {
    span.setAttribute(traceTypes.ATTR_AGENT_LABEL, this.agent.id);

    const unlock = await this.lock.lock();
    try {
      if (this._schedulingPaused) return undefined;

      this._onExitTask = this.createSpeechTask({
        taskFn: () =>
          tracer.startActiveSpan(async () => this.agent.onExit(), {
            name: 'on_exit',
            attributes: { [traceTypes.ATTR_AGENT_LABEL]: this.agent.id },
          }),
        inlineTask: true,
        name: 'AgentActivity_onExit',
      });

      this.cancelPreemptiveGeneration();

      await this._onExitTask.result;
      await this._pauseSchedulingTask([]);

      // detach after speech tasks are done but before _closeSessionResources
      if (newActivity) {
        try {
          return await this._detachReusableResources(newActivity);
        } catch (error) {
          this.logger.error(error, 'failed to detach reusable resources');
        }
      }
      return undefined;
    } finally {
      unlock();
    }
  }

  async close(): Promise<void> {
    const unlock = await this.lock.lock();
    try {
      this.cancelPreemptiveGeneration();

      await cancelAndWait(Array.from(this.speechTasks), AgentActivity.REPLY_TASK_CANCEL_TIMEOUT);

      if (this._currentSpeech && !this._currentSpeech.done()) {
        this._currentSpeech._markDone();
      }

      await this.cancelSpeechPause({ interrupt: false });
      this.cancelSpeechPauseTask = undefined;

      await this._closeSessionResources();

      if (this._mainTask) {
        await this._mainTask.cancelAndWait();
      }
      if (this.interruptionDetector) {
        this.interruptionDetector.off('overlapping_speech', this.onInterruptionOverlappingSpeech);
        this.interruptionDetector.off('metrics_collected', this.onInterruptionMetricsCollected);
        this.interruptionDetector.off('error', this.onInterruptionError);
      }

      this.agent._agentActivity = undefined;
    } finally {
      unlock();
    }
  }

  private resolveInterruptionDetector(): AdaptiveInterruptionDetector | undefined {
    const agentInterruptionDetection = this.agent.turnHandling?.interruption?.mode;
    const sessionInterruptionDetection = this.agentSession.interruptionDetection;
    if (
      !(
        this.stt &&
        this.stt.capabilities.alignedTranscript &&
        this.stt.capabilities.streaming &&
        this.vad &&
        this.turnDetection !== 'manual' &&
        this.turnDetection !== 'realtime_llm' &&
        !(this.llm instanceof RealtimeModel)
      )
    ) {
      if (
        agentInterruptionDetection === 'adaptive' ||
        sessionInterruptionDetection === 'adaptive'
      ) {
        this.logger.warn(
          "interruptionDetection is provided, but it's not compatible with the current configuration and will be disabled",
        );
      }
      return undefined;
    }

    if (!this.allowInterruptions) {
      return undefined;
    }

    if (agentInterruptionDetection === 'vad') {
      return undefined;
    }

    if (sessionInterruptionDetection === 'vad') {
      return undefined;
    }

    if (
      agentInterruptionDetection === undefined &&
      sessionInterruptionDetection === undefined &&
      !isHosted() &&
      !isDevMode()
    ) {
      this.logger.info('adaptive interruption is disabled by default in production mode');
      return undefined;
    }

    try {
      const detector = new AdaptiveInterruptionDetector();

      detector.on('overlapping_speech', this.onInterruptionOverlappingSpeech);
      detector.on('metrics_collected', this.onInterruptionMetricsCollected);
      detector.on('error', this.onInterruptionError);

      return detector;
    } catch (error: unknown) {
      this.logger.warn({ error }, 'could not instantiate AdaptiveInterruptionDetector');
    }
    return undefined;
  }

  private updatePausedSpeech(speechHandle: SpeechHandle, timeout: number): void {
    if (this.pausedSpeech && this.pausedSpeech.handle === speechHandle) {
      this.pausedSpeech.timeout = timeout;
    } else {
      this.pausedSpeech = {
        handle: speechHandle,
        agentState: this.agentSession.agentState,
        timeout,
      };
    }
  }

  private pauseEnabled(): boolean {
    const interruptionOptions = this.agentSession.sessionOptions.turnHandling.interruption;
    return !!(
      interruptionOptions.resumeFalseInterruption &&
      interruptionOptions.falseInterruptionTimeout !== undefined &&
      this.agentSession.output.audio &&
      this.agentSession.output.audio.canPause
    );
  }

  private startFalseInterruptionTimer(timeout: number): void {
    if (this.falseInterruptionTimer !== undefined) {
      clearTimeout(this.falseInterruptionTimer);
    }

    this.falseInterruptionTimer = setTimeout(() => {
      if (
        !this.pausedSpeech ||
        (this._currentSpeech && this._currentSpeech !== this.pausedSpeech.handle)
      ) {
        // already new speech is scheduled, do nothing
        this.pausedSpeech = undefined;
        return;
      }

      let resumed = false;
      const interruptionOptions = this.agentSession.sessionOptions.turnHandling.interruption;
      const audioOutput = this.agentSession.output.audio;
      if (
        interruptionOptions.resumeFalseInterruption &&
        audioOutput &&
        audioOutput.canPause &&
        !this.pausedSpeech.handle.done()
      ) {
        this.agentSession._updateAgentState(this.pausedSpeech.agentState, {
          otelContext: this.pausedSpeech.handle._agentTurnContext,
        });
        if (this.audioRecognition && this.pausedSpeech.agentState === 'speaking') {
          this.audioRecognition.onStartOfAgentSpeech(Date.now());
        }
        if (this.isInterruptionDetectionEnabled) {
          this.disableVadInterruptionSoon();
        }
        audioOutput.resume();
        resumed = true;
        this.logger.debug({ timeout }, 'resumed false interrupted speech');
      }

      this.agentSession.emit(
        AgentSessionEventTypes.AgentFalseInterruption,
        createAgentFalseInterruptionEvent({ resumed }),
      );

      this.pausedSpeech = undefined;
      this.falseInterruptionTimer = undefined;
    }, timeout);
  }

  private async cancelSpeechPause(options?: { interrupt?: boolean }): Promise<void> {
    const { interrupt = true } = options ?? {};

    // await any previously-started cancel task to avoid races
    if (this.cancelSpeechPauseTask) {
      try {
        await this.cancelSpeechPauseTask;
      } catch {
        this.logger.debug('previous cancelSpeechPause task failed, ignoring');
      }
      this.cancelSpeechPauseTask = undefined;
    }

    if (this.falseInterruptionTimer !== undefined) {
      clearTimeout(this.falseInterruptionTimer);
      this.falseInterruptionTimer = undefined;
    }

    if (!this.pausedSpeech) {
      return;
    }

    if (
      interrupt &&
      !this.pausedSpeech.handle.interrupted &&
      this.pausedSpeech.handle.allowInterruptions
    ) {
      this.pausedSpeech.handle.interrupt();
      // ensure the generation is done — but only if a generation
      // was actually started
      if (this.pausedSpeech.handle._hasGenerations) {
        await this.pausedSpeech.handle._waitForGeneration();
      }
    }
    this.pausedSpeech = undefined;

    const interruptionOptions = this.agentSession.sessionOptions.turnHandling.interruption;
    if (interruptionOptions.resumeFalseInterruption && this.agentSession.output.audio) {
      this.agentSession.output.audio.resume();
    }
  }

  /**
   * Disable VAD-based interruption either immediately or after the backchannel boundary
   * cooldown expires. While the cooldown is active the VAD path stays enabled, allowing the
   * user to correct themselves at the very start of agent speech.
   */
  private disableVadInterruptionSoon(): void {
    const audioRecognition = this.audioRecognition;
    if (audioRecognition && audioRecognition.backchannelBoundaryActive) {
      audioRecognition.backchannelBoundaryCallback = () => {
        // Only disable VAD interruption if the agent is still speaking when the timer expires.
        if (
          this.agentSession.agentState === 'speaking' &&
          this.isInterruptionByAudioActivityEnabled
        ) {
          this.logger.trace('backchannel boundary expired');
          this.isInterruptionByAudioActivityEnabled = false;
        }
      };
    } else {
      this.isInterruptionByAudioActivityEnabled = false;
    }
  }

  private restoreInterruptionByAudioActivity(): void {
    this.audioRecognition?.cancelBackchannelBoundary();
    this.isInterruptionByAudioActivityEnabled = this.isDefaultInterruptionByAudioActivityEnabled;
  }

  private fallbackToVadInterruption(error?: InterruptionDetectionError): void {
    if (!this.isInterruptionDetectionEnabled) return;

    this.isInterruptionDetectionEnabled = false;
    this.restoreInterruptionByAudioActivity();

    if (this.interruptionDetector) {
      this.interruptionDetector.off('overlapping_speech', this.onInterruptionOverlappingSpeech);
      this.interruptionDetector.off('metrics_collected', this.onInterruptionMetricsCollected);
      this.interruptionDetector.off('error', this.onInterruptionError);
      this.interruptionDetector = undefined;
    }

    if (this.audioRecognition) {
      this.audioRecognition.disableInterruptionDetection().catch((err) => {
        this.logger.warn({ err }, 'error while disabling interruption detection');
      });
    }

    this.logger.info(
      {
        error: error?.message,
        label: error?.label,
      },
      'adaptive interruption disabled due to unrecoverable error, falling back to VAD-based interruption',
    );
  }

  private async _closeSessionResources(): Promise<void> {
    // Unregister event handlers to prevent duplicate metrics
    if (this.llm instanceof LLM) {
      this.llm.off('metrics_collected', this.onMetricsCollected);
      this.llm.off('error', this.onModelError);
    }

    if (this.realtimeSession) {
      this.realtimeSession.off('generation_created', this.onRealtimeGenerationCreated);
      this.realtimeSession.off('input_speech_started', this.onRealtimeInputSpeechStarted);
      this.realtimeSession.off('input_speech_stopped', this.onRealtimeInputSpeechStopped);
      this.realtimeSession.off(
        'input_audio_transcription_completed',
        this.onRealtimeInputAudioTranscriptionCompleted,
      );
      this.realtimeSession.off('metrics_collected', this.onMetricsCollected);
      this.realtimeSession.off('error', this.onModelError);
    }

    if (this.stt instanceof STT) {
      this.stt.off('metrics_collected', this.onMetricsCollected);
      this.stt.off('error', this.onModelError);
    }

    if (this.tts instanceof TTS) {
      this.tts.off('metrics_collected', this.onMetricsCollected);
      this.tts.off('error', this.onModelError);
    }

    if (this.vad instanceof VAD) {
      this.vad.off('metrics_collected', this.onMetricsCollected);
    }

    this.detachAudioInput();
    this.realtimeSpans?.clear();
    await this.realtimeSession?.close();
    await this.audioRecognition?.close();
    this.realtimeSession = undefined;
    this.audioRecognition = undefined;
  }
}

function toOaiToolChoice(toolChoice: ToolChoice | null): ToolChoice | undefined {
  // we convert null to undefined, which maps to the default provider tool choice value
  return toolChoice !== null ? toolChoice : undefined;
}
