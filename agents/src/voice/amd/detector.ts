// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame, RemoteParticipant } from '@livekit/rtc-node';
import { ParticipantKind, RoomEvent, TrackKind } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { APIError } from '../../_exceptions.js';
import * as inference from '../../inference/index.js';
import type { ChatContext } from '../../llm/chat_context.js';
import { ChatMessage } from '../../llm/chat_context.js';
import { LLM } from '../../llm/llm.js';
import { RealtimeModel } from '../../llm/realtime.js';
import { ToolContext, type ToolContextEntry } from '../../llm/tool_context.js';
import { log } from '../../log.js';
import type { STT } from '../../stt/stt.js';
import {
  Event,
  Future,
  Task,
  cancelAndWait,
  isCloud,
  waitForParticipantAttribute,
  waitForTrackPublication,
} from '../../utils.js';
import type { Agent } from '../agent.js';
import type { AgentSession, AgentSessionCallbacks } from '../agent_session.js';
import {
  type AgentFalseInterruptionEvent,
  AgentSessionEventTypes,
  type AgentStateChangedEvent,
  type ConversationItemAddedEvent,
  type FunctionToolsExecutedEvent,
  type SpeechCreatedEvent,
  type UserInputTranscribedEvent,
  type UserStateChangedEvent,
  zipFunctionCallsAndOutputs,
} from '../events.js';
import type { SpeechHandle } from '../speech_handle.js';
import type { TurnHooks } from '../turn_hooks.js';
import { AMDChatContext, type AMDRequest, type Turn } from './chat_context.js';
import {
  type AMDCallbacks,
  AMDCategory,
  type AMDCompletedEvent,
  AMDLifecycle,
  type AMDPredictionEvent,
  AMDReason,
  createAMDCompletedEvent,
  createAMDPredictionEvent,
} from './events.js';
import * as fsm from './fsm.js';
import * as amdInference from './inference.js';
import { AMDTranscriber } from './stt.js';

/** Allow transient delays before abandoning detection. */
const DEFAULT_MAX_INFERENCE_TIMEOUTS = 3;
/** Wait for a pause before replying to machines. */
const MACHINE_SILENCE_THRESHOLD = 1_500;
/** Stop optional menu work before it becomes stale. */
const MENU_TIMEOUT = 5_000;
const TRACK_PUBLICATION_TIMEOUT = 5_000;
const MACHINE_CATEGORIES: ReadonlySet<AMDCategory> = new Set([
  AMDCategory.MACHINE_SCREENING,
  AMDCategory.MACHINE_VM,
  AMDCategory.MACHINE_IVR,
  AMDCategory.MACHINE_UNAVAILABLE,
]);

const SIP_CALL_STATUS_ATTR = 'sip.callStatus';
const SIP_CALL_STATUS_ACTIVE = 'active';

export const DEFAULT_SCREENING_INSTRUCTIONS =
  "Call state: automated call screening. Answer the screening assistant's latest " +
  'prompt briefly. Use what you know about who you are and why you are calling. ' +
  'Then wait for its next prompt.';
export const DEFAULT_VOICEMAIL_INSTRUCTIONS =
  'Call state: voicemail. Deliver one concise, self-contained message. ' +
  'State who you are, why you are calling, and the next step for the recipient.';
export const DEFAULT_IVR_INSTRUCTIONS =
  "Call state: an automated phone menu. Use the participant's actual prompt and " +
  'the purpose of this call to choose the next step. Use send_dtmf_events for an ' +
  'explicit keypad choice, or give a short spoken answer when requested. ' +
  'Do not invent a menu option. After the action, wait for the next prompt.';
export const DEFAULT_HUMAN_INSTRUCTIONS =
  'Call state: a human has answered. The latest participant turn is from ' +
  'the human, not the automated system. Earlier automated prompts no longer ' +
  "apply. Respond to the human's latest message and continue the call normally. " +
  'Do not resume a response to an earlier automated prompt.';

const DEFAULT_LLM_MODEL = 'google/gemma-4-31b-it';
const DEFAULT_STT_MODEL = 'cartesia/ink-whisper';

export interface AMDOptions {
  /**
   * Classification and menu model. When omitted, use `google/gemma-4-31b-it` if
   * LiveKit Cloud credentials are available; otherwise use the current Agent's LLM.
   * Pass `null` to always use the current Agent's LLM. A string selects a LiveKit
   * Inference model. Calls use `session.connOptions.llmConnOptions`. Supplied models
   * stay open when AMD completes.
   */
  llm?: LLM | string | null;
  /**
   * Optional streaming STT model for AMD. When omitted, use `cartesia/ink-whisper` if
   * LiveKit Cloud credentials are available; otherwise use only the session transcript.
   * Pass `null` to always use only the session transcript. With session STT configured,
   * the classifier sees both transcripts of each turn. A string selects a LiveKit
   * Inference model.
   */
  stt?: STT | string | null;
  /** Select the participant before placing an outbound call. */
  participantIdentity?: string;
  /**
   * Discard pre-answer audio from AMD and AgentSession when `true`. When `false`, listen
   * to subscribed SIP early media. Defaults to `true`.
   */
  waitUntilAnswered?: boolean;
  /** Instructions for each screening turn. */
  screeningInstructions?: string;
  /** Instructions for one successfully played voicemail message. */
  voicemailInstructions?: string;
  /**
   * Instructions for each IVR turn. The SDK supplies a DTMF tool only to IVR reply
   * generations.
   */
  ivrInstructions?: string;
  /**
   * Temporary instructions for the first human turn after a machine stage. Skipped if no
   * machine stage preceded the human.
   */
  humanInstructions?: string;
  /** Silent, inactive time before AMD completes outside voicemail, in ms. Defaults to 10 s. */
  idleTimeout?: number;
  /**
   * Silent, inactive time in voicemail, in ms. Starts after playback finishes, to allow a
   * delayed post-message menu to arrive. Defaults to 60 s.
   */
  voicemailIdleTimeout?: number;
  /** Hard limit from the start of listening, in ms. Defaults to 120 s. */
  timeout?: number;
  /** Prediction deadline per committed turn, in ms. Late results are ignored. Defaults to 2 s. */
  inferenceTimeout?: number;
  /**
   * Continuous participant silence before a machine reply plays, in ms. Includes silence
   * before and during classification. Pipeline reply generation starts before the silence
   * ends; realtime generation starts after it. Predictions update the category immediately. Replies outside a machine stage do not
   * wait. Set to zero to disable the extra silence wait. Defaults to 1.5 s.
   */
  machineSilenceThreshold?: number;
  /**
   * Consecutive uncertain predictions before completion with the current stage. A wait
   * prediction resets the count. Defaults to 3.
   */
  maxUncertainTurns?: number;
  /** Prediction timeouts before completion. A valid prediction resets the count. Defaults to 3. */
  maxInferenceTimeouts?: number;
}

interface ResolvedOptions {
  idleTimeout: number;
  voicemailIdleTimeout: number;
  timeout: number;
  inferenceTimeout: number;
  machineSilenceThreshold: number;
  maxUncertainTurns: number;
  maxInferenceTimeouts: number;
}

interface ReplyDecision {
  allow: boolean;
  instructionsFor?: AMDCategory;
  trackVoicemail?: boolean;
}

/** Resources and saved settings from `start()` until completion. */
interface AMDResources {
  agent: Agent;
  llm: LLM;
  completion: Future<AMDCompletedEvent>;
  stt: AMDTranscriber;
  sessionAllowInterruptions: boolean;
  agentAllowInterruptions: boolean | undefined;
}

class AMDTurnHooks implements TurnHooks {
  replyInstructions: string | undefined = undefined;
  private trackVoicemail = false;

  constructor(
    private readonly amd: AMD,
    private readonly turnId: number | undefined = undefined,
  ) {}

  onUserTurnCommitted(transcript: string, endOfTurnDelay: number | undefined): TurnHooks {
    return this.amd._onUserTurnCommitted(transcript, endOfTurnDelay);
  }

  onUserTurnCompleted(): void {
    this.amd._updateIdle();
  }

  onReplyGeneration(tools: ToolContext): ToolContext {
    return this.amd._onReplyGeneration(tools);
  }

  async shouldReply(chatCtx: ChatContext): Promise<boolean> {
    if (this.turnId === undefined) {
      return this.amd._state !== AMDCategory.MACHINE_UNAVAILABLE && !this.amd._shouldWait;
    }
    const decision = await this.amd._shouldReply(this.turnId, chatCtx);
    this.trackVoicemail = decision.trackVoicemail ?? false;
    if (decision.instructionsFor !== undefined) {
      this.replyInstructions = this.amd._getInstructions(decision.instructionsFor);
    }
    return decision.allow;
  }

  onAgentTurnCommitted(handle: SpeechHandle): void {
    if (this.turnId !== undefined && this.turnId === this.amd._heldTurnId) {
      this.amd._heldReply = handle;
    }
    if (this.trackVoicemail) {
      this.amd._trackVoicemail(this.turnId!, handle);
    }
  }
}

/**
 * Multi-turn answering-machine detection.
 *
 * Start an AgentSession before starting AMD. Start AMD before creating a SIP
 * participant. `execute()` waits for completion, not the first machine prediction.
 * The SDK owns classification and stage control. Models can use any provider.
 *
 * AMD uses the customer's current Agent. Realtime models require client-side
 * turn detection, session or AMD STT, and per-response tool
 * control. Agent handoffs during AMD are not supported. Normal hooks, interruptions,
 * playback, and StopResponse stay in AgentSession. Menu events are informational
 * and never execute actions.
 * AMD enables interruptions on the session and current Agent, then restores
 * their settings when detection finishes. Direct speech generation during AMD
 * is not supported.
 *
 * @example
 * ```ts
 * const amd = new voice.AMD(session);
 * await amd.start();
 * try {
 *   const result = await amd.execute();
 * } finally {
 *   await amd.aclose();
 * }
 * ```
 */
export class AMD extends (EventEmitter as new () => TypedEmitter<AMDCallbacks>) {
  private readonly session: AgentSession;
  private readonly turnHooks: AMDTurnHooks;
  private readonly ownsLlm: boolean;
  private readonly llmModel: string | undefined;
  private llm: LLM | undefined;
  private readonly ownsStt: boolean;
  private readonly sttModel: string | undefined;
  private stt: STT | undefined;
  private participantIdentity: string | undefined;
  private readonly waitUntilAnswered: boolean;
  private readonly instructions: ReadonlyMap<AMDCategory, string>;
  private readonly options: ResolvedOptions;
  private uncertainTurns = 0;
  private inferenceTimeouts = 0;

  private hardDeadline: number | undefined;
  private inferenceDeadline: number | undefined;
  private idleDeadline: number | undefined;
  private _lifecycle = AMDLifecycle.INITIALIZED;
  private completionReason = AMDReason.CANCELLED;
  private previousStage: AMDCategory | undefined;
  private hadMachineStage = false;
  /** @internal */
  _state = AMDCategory.UNCERTAIN;
  /** latest prediction, may be wait */
  private category = AMDCategory.UNCERTAIN;
  /** @internal */
  _shouldWait = false;
  private chatCtx = new AMDChatContext();
  private turns = new Map<number, Turn>();
  /** @internal */
  _turnId = 0;
  private startedAt: number | undefined;
  private speechStartedAt: number | undefined;
  private speechEndedAt: number | undefined;
  private speechDuration = 0;
  private speechSinceCommit = false;
  private pendingTurn: Turn | undefined;
  private latest: AMDPredictionEvent | null = null;
  private run: AMDResources | undefined;
  private speeches = new Set<SpeechHandle>();
  /** @internal */
  _heldTurnId: number | undefined;
  /** @internal */
  _heldReply: SpeechHandle | undefined;

  private readonly sessionId = randomUUID().replace(/-/g, '');
  private readonly controlPrefix = `amd_${randomUUID().replace(/-/g, '')}_`;

  private voicemailTurnId: number | undefined;
  private voicemailMessagePlayed = false;
  private voicemailHandle: SpeechHandle | undefined;
  private voicemailAudioStart = 0;

  private predictionChanged = new Event();
  private classifierTask: Task<void> | undefined;
  private menuTask: Task<void> | undefined;
  private finishTask: Promise<void> | undefined;
  private tasks = new Set<Task<void>>();
  private unsubscribers: Array<() => void> = [];
  /** Detached after cleanup, when no model call can still report an error. */
  private errorUnsubscribers: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private logger = log();
  private dtmfTool: ToolContextEntry | undefined;

  constructor(session: AgentSession, options: AMDOptions = {}) {
    super();
    const {
      participantIdentity,
      waitUntilAnswered = true,
      screeningInstructions = DEFAULT_SCREENING_INSTRUCTIONS,
      voicemailInstructions = DEFAULT_VOICEMAIL_INSTRUCTIONS,
      ivrInstructions = DEFAULT_IVR_INSTRUCTIONS,
      humanInstructions = DEFAULT_HUMAN_INSTRUCTIONS,
      idleTimeout = 10_000,
      voicemailIdleTimeout = 60_000,
      timeout = 120_000,
      inferenceTimeout = 2_000,
      machineSilenceThreshold = MACHINE_SILENCE_THRESHOLD,
      maxUncertainTurns = 3,
      maxInferenceTimeouts = DEFAULT_MAX_INFERENCE_TIMEOUTS,
    } = options;
    let { llm, stt } = options;

    if (
      Math.min(idleTimeout, voicemailIdleTimeout, timeout, inferenceTimeout) <= 0 ||
      maxUncertainTurns < 1
    ) {
      throw new Error('amd timeouts and maxUncertainTurns must be positive');
    }
    if (maxInferenceTimeouts < 1) {
      throw new Error('maxInferenceTimeouts must be positive');
    }
    if (machineSilenceThreshold < 0) {
      throw new Error('machineSilenceThreshold must be non-negative');
    }
    if (llm === undefined || stt === undefined) {
      const apiKey = process.env.LIVEKIT_INFERENCE_API_KEY || process.env.LIVEKIT_API_KEY;
      const apiSecret = process.env.LIVEKIT_INFERENCE_API_SECRET || process.env.LIVEKIT_API_SECRET;
      let autoSelect = false;
      try {
        autoSelect =
          isCloud(new URL(process.env.LIVEKIT_URL ?? '')) && Boolean(apiKey) && Boolean(apiSecret);
      } catch {
        // an invalid URL is not LiveKit Cloud
      }
      if (llm === undefined) {
        llm = autoSelect ? DEFAULT_LLM_MODEL : null;
      }
      if (stt === undefined) {
        stt = autoSelect ? DEFAULT_STT_MODEL : null;
      }
    }

    this.session = session;
    this.turnHooks = new AMDTurnHooks(this);
    this.ownsLlm = typeof llm === 'string';
    this.llmModel = typeof llm === 'string' ? llm : undefined;
    this.llm = typeof llm === 'string' ? undefined : llm ?? undefined;
    this.ownsStt = typeof stt === 'string';
    this.sttModel = typeof stt === 'string' ? stt : undefined;
    this.stt = typeof stt === 'string' ? undefined : stt ?? undefined;
    if (this.stt !== undefined && !this.stt.capabilities.streaming) {
      throw new Error('amd requires a streaming STT');
    }
    this.participantIdentity = participantIdentity;
    this.waitUntilAnswered = waitUntilAnswered;
    this.instructions = new Map([
      [AMDCategory.MACHINE_SCREENING, screeningInstructions],
      [AMDCategory.MACHINE_VM, voicemailInstructions],
      [AMDCategory.MACHINE_IVR, ivrInstructions],
      [AMDCategory.HUMAN, humanInstructions],
    ]);
    this.options = {
      idleTimeout,
      voicemailIdleTimeout,
      timeout,
      inferenceTimeout,
      machineSilenceThreshold,
      maxUncertainTurns,
      maxInferenceTimeouts,
    };
  }

  private get resources(): AMDResources {
    if (this.run === undefined) {
      throw new Error('start AMD before use');
    }
    return this.run;
  }

  /** Current lifecycle state of this AMD run. */
  get lifecycle(): AMDLifecycle {
    return this._lifecycle;
  }

  /** @internal */
  get _blocksSessionAudio(): boolean {
    return this.lifecycle !== AMDLifecycle.ACTIVE && this.lifecycle !== AMDLifecycle.FINISHED;
  }

  /**
   * Install AMD on the session. Mirrors Python's `async with AMD(session)` entry: call
   * {@link AMD.aclose} when done, for example in a `finally` block.
   */
  async start(): Promise<this> {
    // Imported lazily, like Python, to keep the beta tools out of the voice import graph.
    // Import first, so the checks below and the installation run without a yield.
    this.dtmfTool ??= (await import('../../beta/tools/send_dtmf.js')).sendDtmfEvents;
    const session = this.session;
    const activity = session._activity;
    if (activity === undefined) {
      throw new Error('start AgentSession before entering AMD');
    }
    if (activity._newTurnsBlocked || session._nextActivity !== undefined) {
      throw new Error('wait for the agent handoff to finish before entering AMD');
    }
    if (activity.llm instanceof RealtimeModel) {
      if (activity._rtTurnDetectionEnabled) {
        throw new Error('amd requires client-side turn detection with realtime models');
      }
      const capabilities = activity.llm.capabilities;
      if (capabilities.autoToolReplyGeneration || !capabilities.perResponseToolChoice) {
        throw new Error(
          'amd requires a realtime model with per-response tools and ' +
            'client-controlled tool replies',
        );
      }
      if (activity.stt === undefined && this.stt === undefined && this.sttModel === undefined) {
        throw new Error('amd requires session STT or AMD STT with realtime models');
      }
    }
    if (session.amd) {
      throw new Error('amd is already active');
    }

    let model = this.llm ?? activity.llm;
    if (this.llmModel === undefined && !(model instanceof LLM)) {
      throw new Error('amd requires an LLM for classification');
    }

    if (this.lifecycle !== AMDLifecycle.INITIALIZED) {
      throw new Error('use a new AMD instance for each run');
    }

    try {
      if (this.llmModel !== undefined) {
        this.llm = inference.LLM.fromModelString(this.llmModel);
      }
      if (this.sttModel !== undefined) {
        this.stt = inference.STT.fromModelString(this.sttModel);
      }
      if (this.stt !== undefined && !this.stt.capabilities.streaming) {
        throw new Error('amd requires a streaming STT');
      }
      model = this.llm ?? activity.llm;
      if (!(model instanceof LLM)) {
        throw new Error('amd requires an LLM for classification');
      }
      this.run = {
        agent: activity.agent,
        llm: model,
        completion: new Future<AMDCompletedEvent>(),
        stt: new AMDTranscriber(this.stt, session.connOptions.sttConnOptions, {
          sessionStt: activity.stt !== undefined,
        }),
        sessionAllowInterruptions: session.sessionOptions.turnHandling.interruption.enabled,
        agentAllowInterruptions: activity.agent._interruptionEnabled,
      };
      // Model errors reach AMD as exceptions. Python emitters drop unhandled "error"
      // events, but Node throws without a listener, which would stop LLM retries.
      const ignoreError = () => {};
      const llm = model;
      llm.on('error', ignoreError);
      this.errorUnsubscribers.push(() => llm.off('error', ignoreError));
      const stt = this.stt;
      if (stt !== undefined) {
        stt.on('error', ignoreError);
        this.errorUnsubscribers.push(() => stt.off('error', ignoreError));
      }
    } catch (error) {
      this._lifecycle = AMDLifecycle.FINISHED;
      await this.closeResources();
      throw error;
    }

    this._lifecycle = AMDLifecycle.PENDING;
    try {
      this.startedAt = Date.now();
      session._setAmd(this);
      session._turnHooks = this.turnHooks;
      session.sessionOptions.turnHandling.interruption.enabled = true;
      activity.agent._setInterruptionEnabled(true);
      activity.pauseReplyAuthorization();

      const subscribe = <K extends AgentSessionEventTypes>(
        event: K,
        handler: AgentSessionCallbacks[K],
      ): void => {
        this.unsubscribers.push(() => session.off(event, handler));
        session.on(event, handler);
      };
      subscribe(AgentSessionEventTypes.UserStateChanged, this.onUserStateChanged);
      subscribe(AgentSessionEventTypes.UserInputTranscribed, this.onUserInputTranscribed);
      subscribe(AgentSessionEventTypes.FunctionToolsExecuted, this.onFunctionToolsExecuted);
      subscribe(AgentSessionEventTypes.ConversationItemAdded, this.onConversationItemAdded);
      subscribe(AgentSessionEventTypes.SpeechCreated, this.onSpeechCreated);
      subscribe(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);
      subscribe(AgentSessionEventTypes.AgentFalseInterruption, this.onFalseInterruption);
      const roomIO = session._roomIO;
      if (roomIO) {
        const room = roomIO.rtcRoom;
        this.unsubscribers.push(() =>
          room.off(RoomEvent.ParticipantDisconnected, this.onDisconnected),
        );
        room.on(RoomEvent.ParticipantDisconnected, this.onDisconnected);
        if (this.participantIdentity !== undefined) {
          roomIO.setParticipant(this.participantIdentity);
        }
      }
      this.spawn((signal) => this.setupListening(signal), 'AMD.setupListening');
    } catch (error) {
      await this.aclose();
      throw error;
    }
    return this;
  }

  async aclose(): Promise<void> {
    if (this.lifecycle === AMDLifecycle.INITIALIZED) {
      return;
    }
    this.finish(AMDReason.CANCELLED);
    if (this.finishTask !== undefined) {
      await this.finishTask;
    }
  }

  /** Wait for detection to complete. */
  async execute(): Promise<AMDCompletedEvent> {
    return this.resources.completion.await;
  }

  /** @internal */
  pushAudio(frame: AudioFrame): void {
    if (this.lifecycle === AMDLifecycle.ACTIVE) {
      this.resources.stt.pushAudio(frame);
    }
  }

  private async setupListening(signal: AbortSignal): Promise<void> {
    const startListening = (): void => {
      if (this.lifecycle !== AMDLifecycle.PENDING) {
        return;
      }
      this.hardDeadline = performance.now() + this.options.timeout;
      this._lifecycle = AMDLifecycle.ACTIVE;
      if (this.session.userState === 'speaking') {
        this.speechStartedAt = performance.now();
        this.speechSinceCommit = true;
      }
      this._updateIdle();
      this.logger.info({ sessionId: this.sessionId }, 'amd started listening');
    };

    const roomIO = this.session._roomIO;
    if (!roomIO) {
      startListening();
      return;
    }
    const room = roomIO.rtcRoom;
    // a timeout or setup cancellation stops the participant waits
    const waitController = new AbortController();
    const onAbort = () => waitController.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    // Python's participant waits fail when the room disconnects; the JS helpers keep waiting
    room.on(RoomEvent.Disconnected, onAbort);
    let timedOut = false;
    const publicationTimeout = setTimeout(() => {
      timedOut = true;
      waitController.abort();
    }, TRACK_PUBLICATION_TIMEOUT);
    try {
      let publication;
      try {
        publication = await waitForTrackPublication({
          room,
          identity: this.participantIdentity,
          kind: TrackKind.KIND_AUDIO,
          waitForSubscription: true,
          signal: waitController.signal,
        });
      } finally {
        clearTimeout(publicationTimeout);
      }
      const publisher = [...room.remoteParticipants.values()].find(
        (p) => publication.sid !== undefined && p.trackPublications.has(publication.sid),
      );
      if (publisher === undefined) {
        this.finish(AMDReason.PARTICIPANT_MISSING);
        return;
      }
      this.participantIdentity = publisher.identity;
      if (this.waitUntilAnswered && publisher.kind === ParticipantKind.SIP) {
        await waitForParticipantAttribute({
          room,
          identity: publisher.identity,
          attribute: SIP_CALL_STATUS_ATTR,
          value: SIP_CALL_STATUS_ACTIVE,
          signal: waitController.signal,
        });
      }
      if (this.lifecycle !== AMDLifecycle.FINISHED) {
        startListening();
      }
    } catch {
      if (signal.aborted && !timedOut) {
        return;
      }
      let reason = AMDReason.PARTICIPANT_MISSING;
      if (!room.isConnected) {
        reason = AMDReason.PARTICIPANT_DISCONNECTED;
      }
      this.finish(reason);
    } finally {
      signal.removeEventListener('abort', onAbort);
      room.off(RoomEvent.Disconnected, onAbort);
    }
  }

  // region: hooks

  private onDisconnected = (participant: RemoteParticipant): void => {
    if (participant.identity === this.participantIdentity) {
      this.finish(AMDReason.PARTICIPANT_DISCONNECTED);
    }
  };

  private onFunctionToolsExecuted = (event: FunctionToolsExecutedEvent): void => {
    if (this.lifecycle !== AMDLifecycle.PENDING && this.lifecycle !== AMDLifecycle.ACTIVE) {
      return;
    }
    if (event.hasAgentHandoff) {
      event.cancelAgentHandoff();
      this.logger.warn('agent handoff cancelled while AMD is running');
    }
    for (const [call, output] of zipFunctionCallsAndOutputs(event)) {
      if (call.createdAt >= this.startedAt!) {
        this.chatCtx.addToolResult(call, output);
      }
    }
  };

  private onConversationItemAdded = (event: ConversationItemAddedEvent): void => {
    if (this.lifecycle !== AMDLifecycle.PENDING && this.lifecycle !== AMDLifecycle.ACTIVE) {
      return;
    }
    const item = event.item;
    if (
      item instanceof ChatMessage &&
      item.role === 'assistant' &&
      item.textContent &&
      item.createdAt >= this.startedAt!
    ) {
      this.chatCtx.addAgentReply(item.createdAt);
    }
  };

  private onUserStateChanged = (event: UserStateChangedEvent): void => {
    if (this.lifecycle !== AMDLifecycle.ACTIVE) {
      return;
    }
    const now = performance.now();
    // Anchor the Unix speech boundary to the monotonic clock, preserving delayed edges.
    const delay =
      event.speechTimestamp !== undefined ? Math.max(0, Date.now() - event.speechTimestamp) : 0;
    if (event.newState === 'speaking') {
      this.speechStartedAt = now - delay;
      this.speechEndedAt = undefined;
      this.speechSinceCommit = true;
    } else if (event.oldState === 'speaking') {
      if (this.speechStartedAt !== undefined) {
        this.speechDuration += Math.max(0, now - delay - this.speechStartedAt);
      }
      this.speechStartedAt = undefined;
      this.speechEndedAt = now - delay;
    }
    this.predictionChanged.set();
    this._updateIdle();
  };

  private onUserInputTranscribed = (event: UserInputTranscribedEvent): void => {
    if (this.lifecycle === AMDLifecycle.ACTIVE && event.isFinal) {
      this.resources.stt.pushTranscript(event.transcript);
    }
  };

  /** @internal */
  _onUserTurnCommitted(transcript: string, endOfTurnDelay: number | undefined): TurnHooks {
    if (this.lifecycle !== AMDLifecycle.ACTIVE || this.checkHardTimeout()) {
      return this.turnHooks;
    }
    const activity = this.session._activity;
    activity?.pauseReplyAuthorization();
    this._heldReply?._cancel();
    this._heldTurnId = undefined;
    this._heldReply = undefined;
    const turnTranscript = this.resources.stt.endTurn(transcript);
    const now = performance.now();
    const speaking = this.session.userState === 'speaking';
    if (!speaking && !this.speechSinceCommit) {
      // No speech edge since the last commit: use the EOT silence estimate.
      this.speechEndedAt = now - Math.max(0, endOfTurnDelay ?? 0);
    }
    let duration = this.speechDuration;
    this.speechDuration = 0;
    if (speaking && this.speechStartedAt !== undefined) {
      duration += Math.max(0, now - this.speechStartedAt);
      this.speechStartedAt = now;
    }
    this.speechSinceCommit = false;
    this._turnId += 1;
    const turn: Turn = {
      turnId: this._turnId,
      committedAt: now,
      transcript: turnTranscript,
      speechDuration: duration,
      prediction: null,
      inferenceDuration: null,
    };
    this.turns.set(turn.turnId, turn);
    this.voicemailTurnId = undefined;
    if (turnTranscript.transcript) {
      this.chatCtx.addTranscript(turn);
      this.cancelClassification();
      this.pendingTurn = turn;
      this.inferenceDeadline = now + this.options.inferenceTimeout;
      const request = this.chatCtx.createRequest(turn, {
        stage: this._state,
        recommended: fsm.recommendedNext(this._state),
        previousPrediction: this.latest,
      });
      if (this.menuTask !== undefined) {
        this.menuTask.cancel();
        this.menuTask = undefined;
      }
      this.classifierTask = this.spawn(
        (signal) => this.classify(turn, request, signal),
        'AMD.classify',
      );
    } else if (this.pendingTurn === undefined) {
      this.recordPrediction(turn, AMDReason.REUSED);
    }
    this.predictionChanged.set();
    this._updateIdle();
    if (
      activity !== undefined &&
      activity.llm instanceof RealtimeModel &&
      !activity.llm.capabilities.userTranscription &&
      activity.stt === undefined &&
      turnTranscript.transcript
    ) {
      const message = ChatMessage.create({
        role: 'user',
        content: [turnTranscript.transcript],
        transcriptConfidence: 0,
      });
      activity.agent._chatCtx.insert(message);
      this.session._conversationItemAdded(message);
    }
    return new AMDTurnHooks(this, turn.turnId);
  }

  private onAgentStateChanged = (_event: AgentStateChangedEvent): void => {
    this._updateIdle();
  };

  private onFalseInterruption = (_event: AgentFalseInterruptionEvent): void => {
    // AgentSession clears its pause state after it emits this event.
    queueMicrotask(() => this._updateIdle());
  };

  // endregion

  // region: classification and extraction

  private cancelClassification(): void {
    const task = this.classifierTask;
    this.classifierTask = undefined;
    this.pendingTurn = undefined;
    this.inferenceDeadline = undefined;
    if (task !== undefined && task !== Task.current() && !task.done) {
      task.cancel();
    }
  }

  private recordPrediction(
    turn: Turn,
    reason: AMDReason,
    {
      effects = [],
      stateChanged = false,
      correctsStage = false,
    }: {
      effects?: readonly fsm.Effect[];
      stateChanged?: boolean;
      correctsStage?: boolean;
    } = {},
  ): void {
    const event = createAMDPredictionEvent({
      turnId: turn.turnId,
      category: this.category,
      stage: this._state,
      correctsStage,
      reason,
      transcript: turn.transcript.transcript,
      speechDuration: turn.speechDuration,
      delay: performance.now() - turn.committedAt,
      inferenceDuration: reason === AMDReason.PREDICTION ? turn.inferenceDuration : null,
    });
    turn.prediction = event;
    if (reason !== AMDReason.REUSED) {
      // reused events repeat this one, so completion keeps the classified turn
      this.latest = event;
    }
    // Empty turns committed during inference reuse its result, each with its own event.
    // A non-empty commit would have cancelled this inference already.
    const events = [event];
    for (let turnId = turn.turnId + 1; turnId <= this._turnId; turnId++) {
      const later = this.turns.get(turnId)!;
      later.prediction = {
        ...events[events.length - 1]!,
        turnId: later.turnId,
        reason: AMDReason.REUSED,
        correctsStage: false,
        transcript: later.transcript.transcript,
        speechDuration: later.speechDuration,
        delay: performance.now() - later.committedAt,
        inferenceDuration: null,
      };
      events.push(later.prediction);
    }

    // Execute effects before notifying listeners, which may commit the next turn.
    for (const effect of effects) {
      if (effect === fsm.Effect.COMPLETE) {
        this.finish(AMDReason.FINISHED);
      } else if (effect === fsm.Effect.EXTRACT_MENU) {
        const transcript = turn.transcript.transcript;
        this.menuTask = this.spawn(
          (signal) => this.extractMenu(turn.turnId, transcript, signal),
          'AMD.extractMenu',
        );
      }
    }
    if (this.uncertainTurns >= this.options.maxUncertainTurns) {
      this.finish(AMDReason.MAX_UNCERTAIN_TURNS);
    }

    this.predictionChanged.set();
    this._updateIdle();

    try {
      if (stateChanged) {
        this.session._activity?._cancelPreemptiveGeneration();
      }

      for (const released of events) {
        const copy = { ...released };
        this.emitEvent('amd_prediction', copy);
        this.session._onAmdPrediction(copy);
        this.logger.info(
          {
            turnId: copy.turnId,
            category: copy.category,
            reason: copy.reason,
            sessionId: this.sessionId,
          },
          'amd prediction',
        );
      }
    } catch (error) {
      this.logger.error({ errorType: errorType(error) }, 'amd prediction handler failed');
      this.finish(AMDReason.INTERNAL_ERROR);
    }
  }

  private async classify(turn: Turn, request: AMDRequest, signal: AbortSignal): Promise<void> {
    const started = performance.now();
    let response: amdInference.AMDResponse | undefined;
    try {
      response = await amdInference.classify(this.resources.llm, request, {
        connOptions: this.session.connOptions.llmConnOptions,
        signal,
      });
      turn.inferenceDuration = performance.now() - started;
    } catch (error) {
      if (Task.current() !== this.classifierTask) {
        return;
      }
      if (!(error instanceof APIError || error instanceof amdInference.AMDResponseError)) {
        throw error;
      }
      this.logger.warn(
        { turnId: turn.turnId, errorType: errorType(error) },
        'amd classification failed',
      );
    }
    // Cancellation is best effort. Providers may return after timeout or supersession.
    if (Task.current() !== this.classifierTask || this.checkHardTimeout()) {
      return;
    }
    if (this.inferenceDeadline !== undefined && performance.now() >= this.inferenceDeadline) {
      this.timeoutInference();
      return;
    }
    this.cancelClassification();
    if (response === undefined) {
      this.forgetCategory();
      this.recordPrediction(turn, AMDReason.INFERENCE_ERROR);
      return;
    }

    const category = response.category;
    const result = fsm.transition(this._state, category);
    const stateChanged = result.nextState !== this._state;
    if (stateChanged) {
      this.previousStage = this._state;
      this.idleDeadline = undefined;
    }
    this._state = result.nextState;
    this.category = category;
    this._shouldWait = category === AMDCategory.WAIT;
    this.hadMachineStage ||= MACHINE_CATEGORIES.has(this._state);
    this.inferenceTimeouts = 0;
    this.uncertainTurns = category === AMDCategory.UNCERTAIN ? this.uncertainTurns + 1 : 0;
    this.recordPrediction(turn, AMDReason.PREDICTION, {
      effects: result.effects,
      stateChanged,
      correctsStage: result.correctsStage,
    });
  }

  private async extractMenu(
    turnId: number,
    transcript: string,
    signal: AbortSignal,
  ): Promise<void> {
    const started = performance.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MENU_TIMEOUT);
    let menu: amdInference.AMDIVRMenuResponse;
    try {
      menu = await amdInference.extractIvrMenu(this.resources.llm, transcript, {
        connOptions: this.session.connOptions.llmConnOptions,
        signal: controller.signal,
      });
    } catch (error) {
      // a cancelled task ends quietly, as Python's CancelledError does
      if (!signal.aborted) {
        this.logger.debug(
          { errorType: timedOut ? 'TimeoutError' : errorType(error) },
          'amd menu extraction failed',
        );
      }
      return;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
    if (
      Task.current() !== this.menuTask ||
      this.lifecycle === AMDLifecycle.FINISHED ||
      !(menu.menu || menu.options.length > 0)
    ) {
      return;
    }
    this.emitEvent('amd_menu_observed', {
      type: 'amd_menu_observed',
      sessionId: this.sessionId,
      turnId,
      menu: menu.menu,
      options: menu.options,
      extractionDuration: performance.now() - started,
    });
  }

  // endregion

  // region: reply controls and hooks

  /**
   * Wait for the turn's prediction, then add stage instructions when a reply is allowed.
   *
   * Generation starts at once. Playback waits until the machine silence hold ends.
   *
   * @internal
   */
  async _shouldReply(turnId: number, chatCtx: ChatContext): Promise<ReplyDecision> {
    if (this.turns.has(turnId)) {
      // wait for the prediction for the given turn
      while (
        turnId === this._turnId &&
        this.lifecycle !== AMDLifecycle.FINISHED &&
        this.turns.get(turnId)!.prediction === null
      ) {
        this.predictionChanged.clear();
        await this.predictionChanged.wait();
      }

      if (
        this.lifecycle !== AMDLifecycle.FINISHED &&
        this.session.currentAgent !== this.resources.agent
      ) {
        this.finish(AMDReason.AGENT_CHANGED);
        return { allow: false };
      }
    }
    if (
      this.lifecycle === AMDLifecycle.FINISHED &&
      this._state === AMDCategory.MACHINE_UNAVAILABLE
    ) {
      return { allow: false };
    }
    if (!this.turns.has(turnId)) {
      return { allow: true };
    }
    if (turnId !== this._turnId) {
      return { allow: false };
    }
    if (this.hardDeadline !== undefined && performance.now() >= this.hardDeadline) {
      this.finish(AMDReason.TIMEOUT);
    }
    const replyDecision = this.authorizeReply(turnId);
    if (!replyDecision.allow) {
      return replyDecision;
    }
    if (replyDecision.instructionsFor !== undefined) {
      this.addInstructions(chatCtx, replyDecision.instructionsFor, turnId);
    }
    const activity = this.session._activity;
    if (this.turns.has(turnId) && this.lifecycle === AMDLifecycle.ACTIVE && activity) {
      if (this.replyHeldAt(performance.now())) {
        this._heldTurnId = turnId;
      } else {
        activity.resumeReplyAuthorization();
      }
    }
    return replyDecision;
  }

  private authorizeReply(turnId: number): ReplyDecision {
    const category = this._state;
    if (this._shouldWait) {
      return { allow: false };
    }
    if (this.lifecycle === AMDLifecycle.FINISHED) {
      const humanAfterMachine = category === AMDCategory.HUMAN && this.hadMachineStage;
      return {
        allow: category !== AMDCategory.MACHINE_UNAVAILABLE,
        instructionsFor: humanAfterMachine ? AMDCategory.HUMAN : undefined,
      };
    }
    if (this.turns.get(turnId)!.prediction === null) {
      return { allow: false };
    }
    if (category === AMDCategory.MACHINE_VM) {
      if (
        this.voicemailMessagePlayed ||
        this.voicemailHandle !== undefined ||
        this.voicemailTurnId !== undefined
      ) {
        return { allow: false };
      }
      this.voicemailTurnId = turnId;
      return { allow: true, instructionsFor: category, trackVoicemail: true };
    }
    return {
      allow: true,
      instructionsFor: category === AMDCategory.UNCERTAIN ? undefined : category,
    };
  }

  /** @internal */
  _getInstructions(stage: AMDCategory): string {
    let content = this.instructions.get(stage)!;
    if (stage === AMDCategory.MACHINE_IVR && this.voicemailMessagePlayed) {
      content += '\nThe voicemail message already played locally.';
    }
    return content;
  }

  private addInstructions(chatCtx: ChatContext, stage: AMDCategory, turnId: number): void {
    chatCtx.addMessage({
      id: `${this.controlPrefix}${turnId}`,
      role: 'user',
      content: this._getInstructions(stage),
      // Date.now() has millisecond resolution. Sort after a user message from the same
      // millisecond, as Python's float clock does, so the instructions stay last.
      createdAt: Date.now() + 0.001,
      extra: { amd_run: this.sessionId, amd_stage: this._state },
    });
  }

  /** @internal */
  _onReplyGeneration(tools: ToolContext): ToolContext {
    if (this.lifecycle === AMDLifecycle.ACTIVE && this._state === AMDCategory.MACHINE_IVR) {
      if (!tools.hasTool(this.dtmfTool!.id)) {
        return new ToolContext([...tools.tools, this.dtmfTool!]);
      }
    }
    return tools;
  }

  private replyHeldAt(now: number): boolean {
    if (
      this.lifecycle !== AMDLifecycle.ACTIVE ||
      !this._turnId ||
      this.options.machineSilenceThreshold === 0
    ) {
      return false;
    }
    const prediction = this.turns.get(this._turnId)!.prediction;
    return (
      prediction !== null &&
      !this._shouldWait &&
      MACHINE_CATEGORIES.has(this._state) &&
      (this.session.userState === 'speaking' ||
        this.speechEndedAt === undefined ||
        now < this.speechEndedAt + this.options.machineSilenceThreshold)
    );
  }

  // endregion

  // region: track voicemail speech handle

  /** @internal */
  _trackVoicemail(turnId: number, handle: SpeechHandle): void {
    if (this.lifecycle !== AMDLifecycle.ACTIVE || this.voicemailTurnId !== turnId) {
      return;
    }
    this.voicemailTurnId = undefined;
    this.voicemailHandle?.removeDoneCallback(this.onVoicemailDone);
    this.voicemailHandle = handle;
    const output = this.session.output.audio;
    this.voicemailAudioStart = output ? output.capturedPlayoutSegments : 0;
    handle.addDoneCallback(this.onVoicemailDone);
  }

  private onVoicemailDone = (handle: SpeechHandle): void => {
    if (handle !== this.voicemailHandle) {
      return;
    }
    handle.removeDoneCallback(this.onVoicemailDone);
    this.voicemailHandle = undefined;
    if (
      this.lifecycle === AMDLifecycle.FINISHED ||
      handle.interrupted ||
      handle.exception() !== undefined
    ) {
      return;
    }
    const output = this.session.output.audio;
    if (output && output.capturedPlayoutSegments > this.voicemailAudioStart) {
      this.voicemailMessagePlayed = true;
      if (this._state === AMDCategory.MACHINE_VM) {
        this.idleDeadline = undefined;
      }
    }
    this._updateIdle();
  };

  private onSpeechCreated = (event: SpeechCreatedEvent): void => {
    if (this.lifecycle === AMDLifecycle.FINISHED) {
      return;
    }
    this.speeches.add(event.speechHandle);
    event.speechHandle.addDoneCallback(this.onSpeechDone);
    this._updateIdle();
  };

  private onSpeechDone = (handle: SpeechHandle): void => {
    this.speeches.delete(handle);
    this._updateIdle();
  };

  // endregion

  // region: timeouts and deadlines

  private checkHardTimeout(): boolean {
    if (this.hardDeadline !== undefined && performance.now() >= this.hardDeadline) {
      this.finish(AMDReason.TIMEOUT);
      return true;
    }
    return false;
  }

  private timeoutInference(): void {
    const turn = this.pendingTurn;
    this.cancelClassification();
    if (turn !== undefined) {
      this.inferenceTimeouts += 1;
      this.forgetCategory();
      this.recordPrediction(turn, AMDReason.INFERENCE_TIMEOUT);
    }
  }

  private forgetCategory(): void {
    // A turn without a prediction is unknown, not a repeat of the previous one: a
    // carried-over wait would block every reply, even to a person who picks up.
    this.category = AMDCategory.UNCERTAIN;
    this._shouldWait = false;
  }

  /** @internal */
  _updateIdle(): void {
    if (this.lifecycle !== AMDLifecycle.ACTIVE || this.checkHardTimeout()) {
      return;
    }
    const now = performance.now();
    const replyHeld = this.replyHeldAt(now);
    const activity = this.session._activity;
    if (this._heldTurnId !== undefined && !replyHeld) {
      this._heldTurnId = undefined;
      this._heldReply = undefined;
      activity?.resumeReplyAuthorization();
    }
    if (
      this.inferenceTimeouts >= this.options.maxInferenceTimeouts &&
      this.pendingTurn === undefined &&
      !replyHeld
    ) {
      this.finish(AMDReason.INFERENCE_TIMEOUT);
      return;
    }
    const busy =
      this.pendingTurn !== undefined ||
      this._shouldWait || // hold music or an advertisement; the hard timeout still applies
      replyHeld ||
      this.session.userState === 'speaking' ||
      this.speeches.size > 0 ||
      activity === undefined ||
      activity._isAgentBusy;
    if (busy) {
      this.idleDeadline = undefined;
    } else if (this.idleDeadline === undefined) {
      const timeout =
        this._state === AMDCategory.MACHINE_VM
          ? this.options.voicemailIdleTimeout
          : this.options.idleTimeout;
      this.idleDeadline = now + timeout;
    }
    this.armTimer(now);
  }

  /** @internal */
  _deadlineAt(now: number): number | undefined {
    let silenceDeadline: number | undefined;
    if (this.replyHeldAt(now) && this.speechEndedAt !== undefined) {
      silenceDeadline = this.speechEndedAt + this.options.machineSilenceThreshold;
    }
    const deadlines = [
      this.hardDeadline,
      this.inferenceDeadline,
      this.idleDeadline,
      silenceDeadline,
    ].filter((at): at is number => at !== undefined);
    return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
  }

  private armTimer(now: number = performance.now()): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const at = this._deadlineAt(now);
    if (at === undefined) {
      return;
    }
    const onDeadline = (): void => {
      this.timer = undefined;
      if (this.lifecycle !== AMDLifecycle.ACTIVE || this.checkHardTimeout()) {
        return;
      }
      const now = performance.now();
      if (this.inferenceDeadline !== undefined && now >= this.inferenceDeadline) {
        this.timeoutInference();
      } else if (this.idleDeadline !== undefined && now >= this.idleDeadline) {
        this.finish(AMDReason.IDLE_TIMEOUT);
      }
      this.predictionChanged.set();
      this._updateIdle();
    };
    this.timer = setTimeout(onDeadline, Math.max(0, at - performance.now()));
  }

  // endregion

  // region: settle and clean up

  private finish(reason: AMDReason): void {
    if (this.lifecycle === AMDLifecycle.FINISHED) {
      return;
    }
    this._lifecycle = AMDLifecycle.FINISHED;
    this.completionReason = reason;
    this.hardDeadline = undefined;
    this.idleDeadline = undefined;
    this.cancelClassification();
    this.predictionChanged.set();
    this.armTimer();
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    for (const speech of this.speeches) {
      speech.removeDoneCallback(this.onSpeechDone);
    }
    if (this.voicemailHandle !== undefined) {
      this.voicemailHandle.removeDoneCallback(this.onVoicemailDone);
      this.voicemailHandle = undefined;
    }
    const session = this.session;
    if (session.amd === this) {
      const resources = this.resources;
      session.sessionOptions.turnHandling.interruption.enabled =
        resources.sessionAllowInterruptions;
      resources.agent._setInterruptionEnabled(resources.agentAllowInterruptions);
      session._setAmd(null);
      if (session._turnHooks === this.turnHooks) {
        session._turnHooks = undefined;
      }
      const activity = session._activity;
      if (activity) {
        if (this._state === AMDCategory.MACHINE_UNAVAILABLE) {
          activity._cancelPendingSpeeches();
        } else {
          activity._cancelPreemptiveGeneration();
        }
        activity.resumeReplyAuthorization();
      }
    }
    this.finishTask = this.cleanup();
    void this.finishTask.catch((error) => {
      this.logger.error({ errorType: errorType(error) }, 'amd completion listener failed');
    });
  }

  private completion(): AMDCompletedEvent {
    if (this.lifecycle !== AMDLifecycle.FINISHED) {
      throw new Error('AMD has not completed');
    }
    let category = this._state;
    if (
      this.voicemailMessagePlayed &&
      category === AMDCategory.MACHINE_UNAVAILABLE &&
      this.previousStage !== undefined
    ) {
      // the box's goodbye after the message ends the box, not an unreachable call
      category = this.previousStage;
    }
    return createAMDCompletedEvent({
      category,
      reason: this.completionReason,
      voicemailMessagePlayed: this.voicemailMessagePlayed,
      lastPrediction: this.latest,
    });
  }

  private async closeResources(): Promise<void> {
    try {
      await this.closeModels();
    } finally {
      for (const unsubscribe of this.errorUnsubscribers) {
        unsubscribe();
      }
      this.errorUnsubscribers = [];
    }
  }

  private async closeModels(): Promise<void> {
    const closeTasks: Promise<void>[] = [];
    if (this.run !== undefined) {
      closeTasks.push(this.run.stt.aclose());
    }
    if (this.ownsStt && this.stt !== undefined) {
      closeTasks.push(this.stt.close());
    }
    if (this.ownsLlm && this.llm !== undefined) {
      closeTasks.push(this.llm.aclose());
    }
    for (const result of await Promise.allSettled(closeTasks)) {
      if (result.status === 'rejected') {
        this.logger.warn({ errorType: errorType(result.reason) }, 'amd resource cleanup failed');
      }
    }
  }

  private async cleanup(): Promise<void> {
    // like asyncio.create_task: start after the caller's synchronous work
    await Promise.resolve();
    try {
      await cancelAndWait([...this.tasks]);
      await this.closeResources();
    } finally {
      const result = this.completion();
      this.resources.completion.resolve(result);
      this.emitEvent('amd_completed', result);
    }
  }

  // endregion

  // region: utilities

  /**
   * Emit like Python's `rtc.EventEmitter`: each listener runs, and a listener error is logged
   * instead of thrown, except a `TypeError`.
   */
  private emitEvent<K extends keyof AMDCallbacks>(
    event: K,
    ...args: Parameters<AMDCallbacks[K]>
  ): void {
    for (const listener of this.rawListeners(event)) {
      try {
        (listener as (...values: Parameters<AMDCallbacks[K]>) => void).apply(this, args);
      } catch (error) {
        if (error instanceof TypeError) {
          throw error;
        }
        this.logger.error({ error }, `failed to emit event ${event}`);
      }
    }
  }

  /** Run a background task that cleanup cancels and that ends the run if it fails. */
  private spawn(fn: (signal: AbortSignal) => Promise<void>, name: string): Task<void> {
    const task = Task.from(
      async (controller) => {
        // like asyncio.create_task: start after the caller's synchronous work
        await Promise.resolve();
        if (!controller.signal.aborted) {
          await fn(controller.signal);
        }
      },
      undefined,
      name,
    );
    this.tasks.add(task);
    task.addDoneCallback(() => this.onTaskDone(task));
    return task;
  }

  private onTaskDone(task: Task<void>): void {
    this.tasks.delete(task);
    if (task.cancelled) {
      return;
    }
    task.result.catch((error: unknown) => {
      this.logger.error({ errorType: errorType(error) }, 'amd task failed');
      this.finish(AMDReason.INTERNAL_ERROR);
    });
  }

  // endregion
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
