// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ParticipantKind, TrackKind } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import type { Span } from '@opentelemetry/api';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { ReadableStream } from 'node:stream/web';
import { z } from 'zod';
import * as inference from '../inference/index.js';
import type { LLMModels, STTModels } from '../inference/index.js';
import { ChatContext } from '../llm/chat_context.js';
import type { FunctionCall } from '../llm/chat_context.js';
import { LLM, type LLMStream } from '../llm/llm.js';
import { ToolContext, type ToolContextEntry, isFunctionTool, tool } from '../llm/tool_context.js';
import { log } from '../log.js';
import { STT, SpeechEventType, type SpeechStream } from '../stt/stt.js';
import { traceTypes, tracer } from '../telemetry/index.js';
import {
  Task,
  delay,
  isCloud,
  waitForParticipantAttribute,
  waitForTrackPublication,
} from '../utils.js';
import type { AgentSession } from './agent_session.js';
import type { EndOfTurnInfo } from './audio_recognition.js';
import { AgentSessionEventTypes } from './events.js';
import { setParticipantSpanAttributes } from './utils.js';

export enum AMDCategory {
  HUMAN = 'human',
  MACHINE_IVR = 'machine-ivr',
  MACHINE_VM = 'machine-vm',
  MACHINE_UNAVAILABLE = 'machine-unavailable',
  UNCERTAIN = 'uncertain',
}

export interface AMDPredictionEvent {
  type: 'amd_prediction';
  category: AMDCategory;
  transcript: string;
  reason: string;
  rawResponse: string;
  isMachine: boolean;
  /** Total speech duration captured before the verdict was settled (ms). */
  speechDurationMs: number;
  /** Time between the end of user speech and the verdict emission (ms). */
  delayMs: number;
}

export type AMDCallbacks = {
  amd_prediction: (event: AMDPredictionEvent) => void;
};

export interface AMDOptions {
  /**
   * LLM used to classify call greetings.
   * - `LLM` instance: used as-is (caller-owned; AMD will not close it).
   * - `string`: treated as a Cloud Inference model id (e.g. `'openai/gpt-4o-mini'`)
   *   and an inference LLM is constructed (AMD-owned).
   * - `undefined` (default): auto-select — if LiveKit Cloud inference credentials
   *   are available in the environment, uses `'google/gemini-3.1-flash-lite'` via
   *   the inference gateway; otherwise falls back to the session's own LLM.
   */
  llm?: LLM | string;
  /**
   * Dedicated STT used to transcribe call audio for AMD.
   * - `STT` instance: used as-is (caller-owned; AMD will not close it).
   * - `string`: treated as a Cloud Inference model id (e.g. `'cartesia/ink-whisper'`)
   *   and an inference STT is constructed (AMD-owned).
   * - `undefined` (default): auto-select — if LiveKit Cloud inference credentials
   *   are available in the environment, uses `'cartesia/ink-whisper'` via the
   *   inference gateway; otherwise reuses the session's existing STT transcripts.
   */
  stt?: STT | string;
  interruptOnMachine?: boolean;
  /** If no speech is heard within this window, settle as UNCERTAIN (not a machine, so no interrupt). */
  noSpeechTimeoutMs?: number;
  /**
   * Overall detection budget. When `waitUntilFinished` is `true` and speech has
   * been heard, this no longer forces emission; AMD keeps waiting for the
   * greeting to finish before releasing the verdict.
   */
  detectionTimeoutMs?: number;
  /** Speech longer than this is treated as machine-like (skips the short-greeting heuristic). */
  humanSpeechThresholdMs?: number;
  /** Silence after a short greeting before settling as HUMAN. */
  humanSilenceThresholdMs?: number;
  /** Silence after machine-like speech before opening the silence gate. */
  machineSilenceThresholdMs?: number;
  /**
   * If `true`, once any speech has been heard, `detectionTimeoutMs` no longer
   * forces emission. AMD waits for post-speech silence and either a session
   * end-of-turn signal or the synthetic `maxEndpointingDelayMs` backstop before
   * emitting. Useful for outbound voicemail flows where leaving a message early
   * would overlap the greeting. `noSpeechTimeoutMs` (uncertain) still fires
   * normally when no audio is heard. Continuous speech without a speech-end or
   * end-of-turn can therefore extend detection beyond `detectionTimeoutMs`; set
   * this to `false` when `detectionTimeoutMs` should remain a hard cap after
   * speech starts. Defaults to `true`.
   * Mirrors python detector.py `wait_until_finished`.
   */
  waitUntilFinished?: boolean;
  /**
   * Fallback end-of-turn delay (ms). When the session turn detector never
   * commits a turn, this synthetic backstop, armed when speech ends or a final
   * transcript arrives, sets the end-of-turn so a gated verdict can still emit.
   * Defaults to the running session activity's endpointing `maxDelay` (so the
   * backstop tracks the real turn detector), or {@link DEFAULT_MAX_ENDPOINTING_DELAY_MS}
   * when no activity is available. Mirrors python `max_endpointing_delay`.
   */
  maxEndpointingDelayMs?: number;
  /** Override the AMD classification system prompt. */
  prompt?: string;
  /**
   * Restrict AMD to a specific participant. Used to filter the
   * `waitForTrackPublication` gate (see python detector.py) and span
   * attribution. When unset, AMD binds to whichever participant the session
   * is linked to.
   */
  participantIdentity?: string;
  /**
   * If true, do not log a warning when the resolved LLM is not among the
   * bundled AMD-tested model strings. Has no effect on classification behavior.
   */
  suppressCompatibilityWarning?: boolean;
}

const HUMAN_SPEECH_THRESHOLD_MS = 2_500;
const HUMAN_SILENCE_THRESHOLD_MS = 500;
const MACHINE_SILENCE_THRESHOLD_MS = 1_500;
const DEFAULT_NO_SPEECH_TIMEOUT_MS = 10_000;
const DEFAULT_DETECTION_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ENDPOINTING_DELAY_MS = 3_000;

const MAX_EXTENSIONS = 3;
const MAX_EXTENSION_MS = 10_000;

const DEFAULT_AMD_LLM_MODEL = 'google/gemini-3.1-flash-lite';
const DEFAULT_AMD_STT_MODEL = 'cartesia/ink-whisper';

const SIP_CALL_STATUS_ATTR = 'sip.callStatus';
const SIP_CALL_STATUS_ACTIVE = 'active';

const EVALUATED_LLM_MODELS: ReadonlySet<string> = new Set([
  'google/gemini-3.1-flash-lite',
  'google/gemini-3-flash-preview',
  'openai/gpt-4.1',
  'openai/gpt-5.2',
  'openai/gpt-5.4',
  'openai/gpt-5.1',
  'openai/gpt-4o',
  'openai/gpt-5.1-chat-latest',
  'openai/gpt-4.1-mini',
  'openai/gpt-4.1-nano',
  'openai/gpt-5.2-chat-latest',
  'google/gemini-2.5-flash-lite',
]);

const EVALUATED_STT_MODELS: ReadonlySet<string> = new Set([
  'deepgram/nova-3',
  'assemblyai/universal-streaming-multilingual',
  'cartesia/ink-whisper',
]);

const MACHINE_CATEGORIES: ReadonlySet<AMDCategory> = new Set([
  AMDCategory.MACHINE_IVR,
  AMDCategory.MACHINE_VM,
  AMDCategory.MACHINE_UNAVAILABLE,
]);

const VALID_CATEGORIES: ReadonlySet<string> = new Set(Object.values(AMDCategory));

function isMachineCategory(category: AMDCategory): boolean {
  return MACHINE_CATEGORIES.has(category);
}

function parseCategory(raw: string | undefined): AMDCategory {
  return typeof raw === 'string' && VALID_CATEGORIES.has(raw)
    ? (raw as AMDCategory)
    : AMDCategory.UNCERTAIN;
}

// Verbatim port of python classifier.py `AMD_PROMPT`. The few-shot examples
// meaningfully steer classification (e.g. "hours of operation" alone → uncertain,
// but with "press 1" → machine-ivr; call-screening → machine-ivr), and this is the
// prompt the EVALUATED_LLM_MODELS set was tuned against. The verdict is committed
// via the `save_prediction` tool (tool_choice='required'), not free-text output.
const AMD_PROMPT = `Task:
Classify the call greeting transcript into exactly one of these categories:

human: A person answered (e.g., "Hello?", "This is John.").
machine-ivr: A prompt to press a key (e.g., "Press 1 to continue").
machine-vm: A voicemail greeting where leaving a message IS possible.
machine-unavailable: Any greeting indicating it's NOT possible to leave message, eg because mailbox is full, not setup, etc.
uncertain: For partial transcripts that are ambiguous.

Examples:
Input: "The person you called has a voice mailbox that hasn't been set up yet. Goodbye."
Output: machine-unavailable

Input: "Thank you for calling Truly Pizza in Dana Pointe. Our hours of operation are 11AM to 8PM, Sunday through Thursday, 11AM to 9PM, Friday and Saturday, and we're closed on Tuesdays."
Output: uncertain

Input: "You for calling Truly Pizza in Dana Pointe. Our hours of operation are 11AM to 8PM, Sunday through Thursday, 11AM to 9PM, Friday and Saturday, and we're closed on Tuesdays. If you'd like to place an order, please press 1 or head to our website to order online for pickup and local delivery."
Output: machine-ivr

Input: "Please state your name and why you're calling, and I will check if the person is available"
Output: machine-ivr
Note: this should apply for any call screening prompts.

Input: "I'm away from my desk. If you leave a message, I will get back to you."
Output: machine-vm

Input: "Hello, this is Lisa."
Output: human`;

function warnIfNotEvaluated(
  modelName: string | undefined,
  evaluated: ReadonlySet<string>,
  modelKind: 'llm' | 'stt',
): void {
  if (!modelName) return;
  const lower = modelName.toLowerCase();
  for (const candidate of evaluated) {
    const c = candidate.toLowerCase();
    if (lower === c || c.includes(lower) || lower.includes(c)) return;
  }
  log().warn(
    { modelKind, model: modelName },
    'model has not been evaluated with the AMD benchmark and may be incompatible',
  );
}

/**
 * Answering Machine Detection.
 *
 * Mirrors Python's `_AMDClassifier` two-gate architecture:
 * a result is only emitted when both a **verdict** (from LLM or heuristic) and
 * a **silence gate** (from VAD or timeout) are satisfied.
 *
 * Emits `'amd_prediction'` once with the final {@link AMDPredictionEvent} when
 * a run settles (mirrors python `AMD(EventEmitter[Literal["amd_prediction"]])`).
 */
export class AMD extends (EventEmitter as new () => TypedEmitter<AMDCallbacks>) {
  private _log = log();
  private readonly llm: LLM;
  /** Dedicated STT for AMD-only transcription, or `undefined` if listening to session events. */
  private readonly stt: STT | undefined;
  /** Whether AMD owns (and must close) the resolved LLM. False when the caller passed an instance. */
  private readonly llmOwned: boolean;
  /** Whether AMD owns (and must close) the resolved STT. */
  private readonly sttOwned: boolean;
  /**
   * Transcript source AMD consumes. `'amd_stt'` when AMD runs its own dedicated
   * STT (session transcripts are ignored), `'stt'` when it relies on the
   * session's STT transcripts. Mirrors python `_AMDClassifier._source`.
   */
  private readonly source: 'stt' | 'amd_stt';
  private readonly interruptOnMachine: boolean;
  private readonly noSpeechTimeoutMs: number;
  private readonly detectionTimeoutMs: number;
  private readonly humanSpeechThresholdMs: number;
  private readonly humanSilenceThresholdMs: number;
  private readonly machineSilenceThresholdMs: number;
  private readonly waitUntilFinished: boolean;
  private readonly maxEndpointingDelayMs: number;
  private readonly prompt: string;
  private readonly participantIdentity: string | undefined;

  // --- execution state (reset per run) ---
  private active = false;
  private listening = false;
  private settled = false;
  private transcriptParts: string[] = [];
  private verdictResult: AMDPredictionEvent | undefined;
  /**
   * Two-gate emission (mirrors python classifier.py `_can_emit`): a verdict is
   * released only when `silenceReached` is true AND, for everything except a
   * confident human, `eotReached` is also true. Humans release on silence
   * alone so the agent can respond quickly.
   */
  private silenceReached = false;
  private eotReached = false;
  private speechStartedAt: number | undefined;
  private speechEndedAt: number | undefined;
  private speechActive = false;
  private detectGeneration = 0;
  private extensionCount = 0;

  private noSpeechTimer: ReturnType<typeof setTimeout> | undefined;
  private detectionTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimerTrigger: 'short_speech' | 'long_speech' | undefined;
  /** Fallback end-of-turn backstop, armed when speech ends. */
  private eotTimer: ReturnType<typeof setTimeout> | undefined;

  private sttStream: SpeechStream | undefined;
  private sttPumpTask: Task<void> | undefined;
  /**
   * Aborts pending {@link waitForTrackPublication} calls in
   * {@link gateListening}. Without this the room-event listener can
   * outlive the AMD instance if the participant track never publishes
   * before the run settles.
   */
  private trackGateAbort: AbortController | undefined;

  /**
   * Tracks the in-flight LLM classification stream so {@link aclose} (and any
   * settled-after-aclose path) can abort it instead of leaving the network
   * call running. Mirrors python's `task.cancel()` on the outstanding
   * classification coroutine.
   */
  private currentLLMStream: LLMStream | undefined;

  private resolveRun: ((value: AMDPredictionEvent) => void) | undefined;
  private rejectRun: ((reason?: unknown) => void) | undefined;
  private span: Span | undefined;

  constructor(
    private readonly session: AgentSession,
    options: AMDOptions = {},
  ) {
    super();

    let { llm, stt } = options;
    if (llm === undefined || stt === undefined) {
      const rawUrl = process.env.LIVEKIT_URL ?? '';
      const apiKey = process.env.LIVEKIT_INFERENCE_API_KEY || process.env.LIVEKIT_API_KEY;
      const apiSecret = process.env.LIVEKIT_INFERENCE_API_SECRET || process.env.LIVEKIT_API_SECRET;
      let autoSelect = false;
      try {
        autoSelect = isCloud(new URL(rawUrl)) && !!(apiKey && apiSecret);
      } catch {
        // invalid URL — not cloud
      }
      if (llm === undefined) llm = autoSelect ? DEFAULT_AMD_LLM_MODEL : undefined;
      if (stt === undefined) stt = autoSelect ? DEFAULT_AMD_STT_MODEL : undefined;
    }

    const { llm: resolvedLLM, owned: llmOwned } = this.resolveLLM(llm);
    this.llm = resolvedLLM;
    this.llmOwned = llmOwned;

    const sttResolution = this.resolveSTT(stt);
    this.stt = sttResolution.stt;
    this.sttOwned = sttResolution.owned;
    this.source = this.stt ? 'amd_stt' : 'stt';

    this.interruptOnMachine = options.interruptOnMachine ?? true;
    this.noSpeechTimeoutMs = options.noSpeechTimeoutMs ?? DEFAULT_NO_SPEECH_TIMEOUT_MS;
    this.detectionTimeoutMs = options.detectionTimeoutMs ?? DEFAULT_DETECTION_TIMEOUT_MS;
    this.humanSpeechThresholdMs = options.humanSpeechThresholdMs ?? HUMAN_SPEECH_THRESHOLD_MS;
    this.humanSilenceThresholdMs = options.humanSilenceThresholdMs ?? HUMAN_SILENCE_THRESHOLD_MS;
    this.machineSilenceThresholdMs =
      options.machineSilenceThresholdMs ?? MACHINE_SILENCE_THRESHOLD_MS;
    this.waitUntilFinished = options.waitUntilFinished ?? true;
    // Mirrors python `_resolve_classifier`: default to the session activity's
    // max_endpointing_delay so the backstop tracks the real turn detector, falling
    // back to the constant when no activity is running (or it's not configured).
    this.maxEndpointingDelayMs =
      options.maxEndpointingDelayMs ??
      this.session._activity?.maxEndpointingDelay ??
      DEFAULT_MAX_ENDPOINTING_DELAY_MS;
    this.prompt = options.prompt ?? AMD_PROMPT;
    this.participantIdentity = options.participantIdentity;

    if (!options.suppressCompatibilityWarning) {
      warnIfNotEvaluated(this.llm.model, EVALUATED_LLM_MODELS, 'llm');
      if (this.stt) {
        warnIfNotEvaluated(this.stt.model, EVALUATED_STT_MODELS, 'stt');
      }
    }

    // Mirrors python detector.py: AMD registers itself with the session so
    // higher-level callers (and tests) can read `session.amd` to introspect
    // the active classifier. We use a duck-typed access so the test mocks in
    // amd.test.ts (which substitute a plain EventEmitter for AgentSession)
    // continue to work without implementing the full session surface.
    (this.session as unknown as { _setAmd?: (amd: AMD | null) => void })._setAmd?.(this);
  }

  // ─── public API ──────────────────────────────────────────────────────────────

  async execute(): Promise<AMDPredictionEvent> {
    return tracer.startActiveSpan(
      async (span) => {
        if (this.active) {
          throw new Error('AMD.execute() is already running');
        }

        this.resetState();
        this.active = true;
        this.span = span;
        this.session.pauseReplyAuthorization();

        span.setAttribute(traceTypes.ATTR_AMD_INTERRUPT_ON_MACHINE, this.interruptOnMachine);
        span.setAttribute(traceTypes.ATTR_GEN_AI_OPERATION_NAME, 'classification');

        const linkedParticipant = this.session._roomIO?.linkedParticipant;
        if (linkedParticipant) {
          setParticipantSpanAttributes(span, linkedParticipant);
        }

        try {
          const result = await new Promise<AMDPredictionEvent>((resolve, reject) => {
            this.resolveRun = resolve;
            this.rejectRun = reject;
            this.subscribe();
            this.startDetectionTimer();
            this.gateListening();
            this.startSTTPump();
          });
          return result;
        } finally {
          this.cleanup();
          this.session.resumeReplyAuthorization();
          this.active = false;
          this.span = undefined;
        }
      },
      {
        name: 'answering_machine_detection',
        context: this.session.rootSpanContext,
      },
    );
  }

  async aclose(): Promise<void> {
    // Mark settled before rejecting so any in-flight `detect()` call sees
    // `isStale()` return true and its tool callbacks no-op. Without this,
    // a postpone_termination resolved after aclose could install a fresh
    // silenceTimer that survives cleanup and triggers session.interrupt.
    this.settled = true;

    // Abort any in-flight LLM classification so the network call doesn't
    // outlive the AMD instance. The async iterator inside `detect()` will
    // throw and the surrounding try/finally clears `currentLLMStream`.
    if (this.currentLLMStream) {
      try {
        this.currentLLMStream.close();
      } catch {
        // already closed
      }
      this.currentLLMStream = undefined;
    }

    if (this.active && this.rejectRun) {
      this.rejectRun(new Error('AMD closed'));
    }
    (this.session as unknown as { _setAmd?: (amd: AMD | null) => void })._setAmd?.(null);

    // Close AMD-owned resources. Caller-supplied LLM/STT instances are NOT
    // closed here — the caller retains ownership for reuse across runs.
    if (this.sttOwned && this.stt) {
      try {
        await this.stt.close();
      } catch (e) {
        this._log.warn({ 'lk.pii.error': e }, 'AMD failed to close owned STT');
      }
    }
    if (this.llmOwned) {
      try {
        await this.llm.aclose();
      } catch (e) {
        this._log.warn({ 'lk.pii.error': e }, 'AMD failed to close owned LLM');
      }
    }
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────────

  private resetState(): void {
    this.settled = false;
    this.listening = false;
    this.transcriptParts = [];
    this.verdictResult = undefined;
    this.silenceReached = false;
    this.eotReached = false;
    this.speechStartedAt = undefined;
    this.speechEndedAt = undefined;
    this.speechActive = false;
    this.silenceTimerTrigger = undefined;
    this.detectGeneration = 0;
    this.extensionCount = 0;
    this.resolveRun = undefined;
    this.rejectRun = undefined;
  }

  private subscribe(): void {
    // Speech boundaries and transcripts are delivered via the public hook
    // methods ({@link onUserSpeechStarted}/{@link onUserSpeechEnded}/{@link onTranscript}),
    // which `AgentActivity` invokes from its recognition hooks — mirroring how
    // python `AudioRecognition` drives `_AMDClassifier`. Only the session-close
    // lifecycle signal is consumed as an event here.
    this.session.on(AgentSessionEventTypes.Close, this.handleClose);
  }

  /**
   * Arms the detection-timeout budget. Started in `execute()` as a backstop against a
   * never-published track, then re-armed in {@link gateListening} at track-up so the
   * effective budget runs from track-subscribe. Re-armable, hence the clear first.
   */
  private startDetectionTimer(): void {
    this.clearTimer('detection');
    this.detectionTimer = setTimeout(() => this.settleDetectionTimeout(), this.detectionTimeoutMs);
  }

  /**
   * The no-speech timer measures how long we've been listening with nothing
   * coming back. It only makes sense after the participant track is actually
   * subscribed (otherwise we'd start counting silence against an audio source
   * that hasn't been wired up yet). Mirrors python detector.py's
   * `_setup` → `wait_for_track_publication` → `start_timers` flow.
   */
  private startNoSpeechTimer(): void {
    if (this.settled || this.noSpeechTimer !== undefined) return;
    this.noSpeechTimer = setTimeout(() => this.settleNoSpeech(), this.noSpeechTimeoutMs);
  }

  private startListening(): void {
    if (this.settled || this.listening) return;
    this.listening = true;
    this.startNoSpeechTimer();
    this._log.debug('AMD starts listening');
  }

  /**
   * Mirrors python detector.py `_run_stt`. When AMD owns its STT, it runs a
   * private pump that:
   *  1. Tees a fresh branch off the participant audio in `AudioRecognition`.
   *  2. Pushes frames into the STT stream.
   *  3. Forwards FINAL_TRANSCRIPTs into the classifier with `source = 'amd_stt'`.
   *
   * The session may not yet have an `AgentActivity` (and therefore no audio
   * stream) by the time AMD constructs its tasks, so we poll briefly until a
   * stream is available, bounded by the abort signal / settled state.
   */
  private startSTTPump(): void {
    if (!this.stt) return;
    this.sttPumpTask = Task.from(({ signal }) => this.runSTTPump(signal));
    this.sttPumpTask.result.catch((err) => {
      if (this.settled) return;
      this._log.warn({ 'lk.pii.error': err }, 'AMD dedicated STT pump exited with error');
    });
  }

  private async runSTTPump(signal: AbortSignal): Promise<void> {
    if (!this.stt) return;

    let audioStream: ReadableStream<AudioFrame> | undefined;
    while (!signal.aborted && !this.settled) {
      audioStream = this.session._subscribeAudioStream?.();
      if (audioStream) break;
      try {
        await delay(100, { signal });
      } catch {
        return;
      }
    }
    if (!audioStream || this.settled || signal.aborted) return;

    const sttStream = this.stt.stream();
    this.sttStream = sttStream;

    const sendPump = (async () => {
      const reader = audioStream!.getReader();
      try {
        while (!signal.aborted && !this.settled) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          if (!this.listening) continue;
          try {
            sttStream.pushFrame(value);
          } catch {
            break;
          }
        }
      } finally {
        // Cancel (rather than just release) so the upstream IdentityTransform
        // closes and `AudioRecognition.subscribeAudioStream`'s registered
        // writer's `.closed` promise resolves — which prunes the entry from
        // `subscriberWriters` and stops the broadcast transform from buffering
        // audio into a stream nobody reads.
        try {
          await reader.cancel();
        } catch {
          // already cancelled / errored
        }
        try {
          sttStream.endInput();
        } catch {
          // already ended/closed
        }
      }
    })();

    const recvPump = (async () => {
      try {
        for await (const event of sttStream) {
          if (signal.aborted || this.settled) break;
          if (event.type !== SpeechEventType.FINAL_TRANSCRIPT) continue;
          const text = event.alternatives?.[0]?.text;
          if (!text) continue;
          // Mirrors python detector `_run_stt` → classifier.push_text(text, source="amd_stt").
          this.onTranscript(text, 'amd_stt');
        }
      } catch (err) {
        if (this.settled) return;
        this._log.debug({ 'lk.pii.error': err }, 'AMD dedicated STT receive pump error');
      }
    })();

    await Promise.allSettled([sendPump, recvPump]);
  }

  /**
   * If the session has a `_roomIO`, defer listening until the participant's
   * audio track is subscribed. For SIP participants, also wait until the call
   * is active so ringback and early media do not burn the no-speech budget.
   * Without `_roomIO`, fall back to listening immediately.
   */
  private gateListening(): void {
    const roomIO = this.session._roomIO;
    const room = roomIO?.rtcRoom;
    if (!room || !room.isConnected) {
      // Mirrors python: "session room_io unavailable, starting amd timers
      // immediately as fallback".
      this.startListening();
      return;
    }

    // Resolve which participant's audio track we're gating on. Mirrors the
    // docstring on `participantIdentity`: explicit option wins; otherwise
    // bind to the session's linked participant; otherwise pass `undefined`
    // so `waitForTrackPublication` matches the first remote participant
    // that publishes a matching audio track. Passing `''` here would make
    // `matches()` reject every real participant (identity !== '' is always
    // true) and the promise would hang forever.
    const targetIdentity = this.participantIdentity ?? roomIO?.linkedParticipant?.identity;

    this.trackGateAbort = new AbortController();
    waitForTrackPublication({
      room,
      identity: targetIdentity,
      kind: TrackKind.KIND_AUDIO,
      waitForSubscription: true,
      signal: this.trackGateAbort.signal,
    })
      .then(async (publication) => {
        if (this.settled) {
          return;
        }

        // Re-anchor the budget at track-subscribe so slow subscription doesn't eat it.
        this.startDetectionTimer();

        const publicationSid = publication.sid;
        const participant = targetIdentity
          ? room.remoteParticipants.get(targetIdentity)
          : publicationSid
            ? [...room.remoteParticipants.values()].find((p) =>
                p.trackPublications.has(publicationSid),
              )
            : undefined;
        if (!participant) {
          // Publisher gone (disconnected in the race window): nothing to gate on.
          // Start listening so the no-speech timer settles AMD instead of stranding
          // it until the detection timeout.
          if (!this.settled) {
            this.startListening();
          }
          return;
        }

        if (participant.kind !== ParticipantKind.SIP) {
          this.startListening();
          return;
        }

        try {
          await waitForParticipantAttribute({
            room,
            identity: participant.identity,
            attribute: SIP_CALL_STATUS_ATTR,
            value: SIP_CALL_STATUS_ACTIVE,
            signal: this.trackGateAbort?.signal,
          });
        } catch (err) {
          // Abort means cleanup is tearing AMD down — don't start listening.
          if (this.trackGateAbort?.signal.aborted) {
            return;
          }
          // Otherwise the SIP participant disconnected before going active: no audio
          // remains, so fall through and let the no-speech timer settle AMD instead
          // of stranding it until the detection timeout.
          this._log.debug(
            { 'lk.pii.error': err },
            'AMD SIP answer wait failed; starting to listen',
          );
        }

        if (!this.settled) {
          this.startListening();
        }
      })
      .catch((err) => {
        // Track gating is best-effort: if waiting for publication fails (e.g.
        // room disconnected, aborted by `cleanup`, or the function rejects),
        // fall back to starting the timer so the run still settles within
        // `noSpeechTimeoutMs`.
        if (this.trackGateAbort?.signal.aborted) {
          return;
        }
        this._log.debug({ 'lk.pii.error': err }, 'AMD listening gate failed; starting immediately');
        if (!this.settled) {
          this.startListening();
        }
      });
  }

  private cleanup(): void {
    this.clearTimer('noSpeech');
    this.clearTimer('detection');
    this.clearTimer('silence');
    this.clearTimer('eot');
    this.listening = false;
    this.session.off(AgentSessionEventTypes.Close, this.handleClose);

    // Detach the track-publication listener — without this, a run that
    // settled via `detectionTimer` before the participant track was ever
    // published would leak its `RoomEvent.TrackSubscribed` listener until
    // the room disconnects.
    if (this.trackGateAbort) {
      this.trackGateAbort.abort();
      this.trackGateAbort = undefined;
    }

    // Tear down the dedicated STT pump (if any). We close the stream first so
    // pushFrame/iter awaits return promptly, then cancel the pump task.
    if (this.sttStream) {
      try {
        this.sttStream.close();
      } catch {
        // already closed
      }
      this.sttStream = undefined;
    }
    if (this.sttPumpTask) {
      this.sttPumpTask.cancel();
      this.sttPumpTask = undefined;
    }
  }

  private clearTimer(name: 'noSpeech' | 'detection' | 'silence' | 'eot'): void {
    const key = `${name}Timer` as 'noSpeechTimer' | 'detectionTimer' | 'silenceTimer' | 'eotTimer';
    if (this[key]) {
      clearTimeout(this[key]);
      this[key] = undefined;
      // Mirrors python `_AMDClassifier`: only clear the trigger flag when a
      // live timer was actually pending. This keeps timer/trigger state in
      // lockstep, so a stale `clearTimer('silence')` call (e.g. in `cleanup`
      // after the timer naturally fired) cannot stomp on a trigger that was
      // freshly set by another path.
      if (name === 'silence') {
        this.silenceTimerTrigger = undefined;
      }
    }
  }

  // ─── two-gate emit system (verdict + silence) ───────────────────────────────

  /**
   * Ref: python classifier.py `_set_verdict` — stores the LLM/heuristic verdict.
   * Emission is deferred until the silence gate also opens.
   */
  private setVerdict(result: AMDPredictionEvent): void {
    this.verdictResult = result;
    this.tryEmitResult();
  }

  /**
   * Ref: python classifier.py `_try_emit_result` + `_can_emit` — releases a
   * verdict only when the silence gate is open AND, for everything except a
   * confident human, the end-of-turn gate is open too. Humans release on
   * silence alone so the agent can respond quickly.
   */
  private tryEmitResult(): void {
    if (!this.verdictResult || this.settled) {
      return;
    }
    if (!this.canEmit(this.verdictResult)) {
      return;
    }
    this.clearTimer('detection');
    this.finish(this.verdictResult);
  }

  /** Ref: python classifier.py `_can_emit`. */
  private canEmit(verdict: AMDPredictionEvent): boolean {
    if (!this.silenceReached) {
      return false;
    }
    return verdict.category === AMDCategory.HUMAN ? true : this.eotReached;
  }

  private finish(result: AMDPredictionEvent): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.cleanup();
    this.setSpanAttributes(result);
    this._log.info(
      {
        category: result.category,
        reason: result.reason,
        isMachine: result.isMachine,
        speechDurationMs: result.speechDurationMs,
        delayMs: result.delayMs,
        'lk.pii.transcript': result.transcript,
      },
      'amd prediction',
    );
    if (result.isMachine && this.interruptOnMachine) {
      this.session.interrupt({ force: true }).await.catch(() => {});
    }
    this.resolveRun?.(result);

    // Mirrors python detector.py: forward the prediction to the SessionHost
    // (so a connected `RemoteSession` peer receives an `amd_prediction`
    // event) and then emit on this `AMD` instance for direct listeners.
    // Duck-typed access keeps the test mocks (which substitute a plain
    // EventEmitter for AgentSession) working without wiring up a host.
    try {
      (
        this.session as unknown as {
          _onAmdPrediction?: (event: AMDPredictionEvent) => void;
        }
      )._onAmdPrediction?.(result);
    } catch (err) {
      this._log.debug({ 'lk.pii.error': err }, 'AMD: session host failed to handle amd_prediction');
    }
    this.emit('amd_prediction', result);
  }

  /**
   * Hook invoked by {@link AgentActivity} when the user turn ends. Mirrors python
   * detector.py `_on_end_of_turn`: signals whether AMD is consuming this turn so
   * the activity should skip the normal reply pipeline.
   *
   * Returns `true` when AMD has settled on a machine verdict and the caller asked
   * us to take over via `interruptOnMachine`; the caller is expected to drive its
   * own `generateReply` (e.g. leaving a voicemail) and the auto-reply triggered by
   * user-turn completion would otherwise race with — and interrupt — it.
   *
   * @internal
   */
  onEndOfTurn(info: EndOfTurnInfo): boolean {
    // Forward the session turn detector's end-of-turn into the emission gate so
    // a verdict that was waiting on end-of-turn (machine/uncertain, or anything
    // under `waitUntilFinished`) can release. Mirrors python detector
    // `_on_end_of_turn` → classifier `on_end_of_turn`.
    this.onEotReached();

    // Only skip once the verdict has actually emitted (`settled`): a committed-but-
    // still-gated machine verdict must not skip ahead of its own interrupt/prediction.
    if (!this.interruptOnMachine || !this.settled || !this.verdictResult?.isMachine) {
      return false;
    }
    this._log.debug(
      {
        category: this.verdictResult.category,
        'lk.pii.transcript': info.newTranscript,
      },
      'skipping auto reply: AMD already returned a machine verdict',
    );
    return true;
  }

  // ─── timer callbacks ─────────────────────────────────────────────────────────

  /**
   * Ref: python classifier.py `_on_silence_reached` — the post-speech silence
   * window elapsed. Opens the silence gate and tries to emit a pending verdict.
   * Does NOT commit a fallback verdict and does NOT touch the end-of-turn gate.
   */
  private onSilenceReached(): void {
    if (this.settled) return;
    this.silenceTimer = undefined;
    this.silenceTimerTrigger = undefined;
    this.silenceReached = true;
    this.tryEmitResult();
  }

  /**
   * Ref: python classifier.py `_on_timeout` — a timeout (detection budget,
   * no-speech, short greeting) fired. Commits a fallback verdict if none exists,
   * then tries to emit. This only decides *what* the verdict is; {@link canEmit}
   * decides *when* it is released. End-of-turn is forced here only when there is
   * nothing left to wait for: no speech was heard, or we are not waiting for the
   * greeting to finish (`waitUntilFinished` off). When `waitUntilFinished` is set
   * and speech was heard, the fallback is still committed but its release stays
   * gated on end-of-turn (the real signal or the backstop timer), so we don't cut
   * the greeting short with an `uncertain` result.
   *
   * Not gated by `listening`: detection_timeout must still fire when the call
   * never reaches listening (e.g. SIP never answered).
   */
  private onTimeout(category: AMDCategory, reason: string, speechDurationMs?: number): void {
    if (this.settled) return;
    this.clearTimer('silence');
    this.silenceReached = true;
    const hasSpeech = this.speechStartedAt !== undefined || this.transcriptParts.length > 0;
    if (!(this.waitUntilFinished && hasSpeech)) {
      this.eotReached = true;
    }
    if (!this.verdictResult) {
      this.setVerdict({
        type: 'amd_prediction',
        category,
        reason,
        transcript: this.joinTranscript(),
        rawResponse: '',
        isMachine: isMachineCategory(category),
        speechDurationMs: speechDurationMs ?? this.computeSpeechDurationMs(),
        delayMs: this.computeDelayMs(),
      });
    }
    this.tryEmitResult();
  }

  /**
   * Ref: python classifier.py `_on_eot_reached` — the session turn detector
   * committed a turn (or the fallback backstop fired). Opens the end-of-turn
   * gate and tries to emit a pending verdict.
   */
  private onEotReached(): void {
    if (this.settled) return;
    this.clearTimer('eot');
    this.eotReached = true;
    this.tryEmitResult();
  }

  private armEotTimer(delayMs = this.maxEndpointingDelayMs): void {
    if (this.settled || this.speechActive) return;
    this.clearTimer('eot');
    this.eotReached = false;
    this.eotTimer = setTimeout(() => this.onEotReached(), delayMs);
  }

  private settleNoSpeech(): void {
    this.onTimeout(AMDCategory.UNCERTAIN, 'no_speech_timeout');
  }

  private settleDetectionTimeout(): void {
    this.onTimeout(AMDCategory.UNCERTAIN, 'detection_timeout');
  }

  // ─── recognition hooks (invoked by AgentActivity, mirroring python AudioRecognition) ───

  /**
   * Ref: python classifier.py `on_user_speech_started` (called from
   * `AudioRecognition._on_vad_event` on VAD START_OF_SPEECH). A new speech
   * segment cancels the pending gates/timers and reopens both emission gates.
   *
   * @internal
   */
  onUserSpeechStarted(): void {
    if (this.settled || !this.listening) return;
    this.clearTimer('silence');
    this.clearTimer('noSpeech');
    this.clearTimer('eot');
    if (this.speechStartedAt === undefined) {
      this.speechStartedAt = performance.now();
    }
    this.speechActive = true;
    this.silenceReached = false;
    this.eotReached = false;
  }

  /**
   * Ref: python classifier.py `on_user_speech_ended(silence_duration)` (called
   * from `AudioRecognition._on_vad_event` on VAD END_OF_SPEECH with
   * `ev.silence_duration`). `silenceDurationMs` is the silence already elapsed
   * when the VAD declared end-of-speech; the true speech-end time is therefore
   * `now - silenceDurationMs`, and every timer is shortened by it so it fires
   * `threshold` after speech actually ended. Mirrors python's
   * `speech_ended_at = time.time() - silence_duration` and
   * `max(0, threshold - silence_duration)`.
   *
   * @internal
   */
  onUserSpeechEnded(silenceDurationMs: number): void {
    if (this.settled || !this.listening) return;
    if (this.speechStartedAt === undefined) {
      this._log.warn('AMD: onUserSpeechEnded called before onUserSpeechStarted');
      return;
    }

    this.speechEndedAt = performance.now() - silenceDurationMs;
    const speechDurationMs = Math.ceil(this.speechEndedAt - this.speechStartedAt);
    const remaining = (thresholdMs: number): number => Math.max(0, thresholdMs - silenceDurationMs);
    this.speechActive = false;

    this.clearTimer('silence');

    // Arm the fallback end-of-turn backstop in case the session turn detector is
    // slow or never commits. Mirrors python on_user_speech_ended's `_arm_eot_timer`.
    this.armEotTimer(remaining(this.maxEndpointingDelayMs));

    // Short greeting: speech ≤ humanSpeechThreshold AND no transcript yet → HUMAN (skip LLM).
    // Otherwise defer to the LLM and use the longer machine_silence_threshold so the
    // classifier can review the words before settling.
    if (speechDurationMs <= this.humanSpeechThresholdMs && this.transcriptParts.length === 0) {
      this.silenceTimer = setTimeout(
        () => this.onTimeout(AMDCategory.HUMAN, 'short_greeting', speechDurationMs),
        remaining(this.humanSilenceThresholdMs),
      );
      this.silenceTimerTrigger = 'short_speech';
      return;
    }

    this.silenceTimer = setTimeout(
      () => this.onSilenceReached(),
      remaining(this.machineSilenceThresholdMs),
    );
    this.silenceTimerTrigger = 'long_speech';
  }

  /**
   * Ref: python classifier.py `push_text(text, source)` (called from
   * `AudioRecognition._on_transcript` with the session STT transcript, and from
   * AMD's dedicated STT with `source='amd_stt'`). Transcripts whose source is not
   * the one AMD is consuming are dropped — so when AMD runs its own STT the
   * session's transcripts are ignored, and vice versa.
   *
   * @internal
   */
  onTranscript(text: string, source: 'stt' | 'amd_stt' = 'stt'): void {
    if (source !== this.source) return;
    const transcript = text.trim();
    if (!transcript) return;
    this.consumeTranscript(transcript);
  }

  /**
   * Shared transcript ingestion: cancels the no-speech timer, refreshes the
   * silence-gate target if we were on the short-greeting path, and fires off
   * an LLM classification on the accumulated transcript.
   */
  private consumeTranscript(transcript: string): void {
    if (this.settled) return;
    if (!this.listening) return;
    this.armEotTimer();
    if (this.silenceTimer && this.silenceTimerTrigger === 'short_speech') {
      this.clearTimer('silence');
      if (this.speechEndedAt !== undefined) {
        const remaining = Math.max(
          0,
          this.speechEndedAt + this.machineSilenceThresholdMs - performance.now(),
        );
        this.silenceTimer = setTimeout(() => this.onSilenceReached(), remaining);
        this.silenceTimerTrigger = 'long_speech';
      }
    }

    this.clearTimer('noSpeech');
    this.transcriptParts.push(transcript);
    this.scheduleLLMClassification();
  }

  private readonly handleClose = (): void => {
    if (this.settled) return;
    // The session is closing — force a settle regardless of the emission gates
    // (open the end-of-turn gate so a non-human fallback can release immediately).
    this.eotReached = true;
    this.onTimeout(AMDCategory.UNCERTAIN, 'session_closed');
  };

  // ─── LLM classification ─────────────────────────────────────────────────────

  /**
   * Schedules an LLM classification. Uses a generation counter so that if a
   * newer transcript arrives while an older classification is in-flight, the
   * stale result is discarded (mirrors Python's cancel-and-rerun pattern).
   */
  private scheduleLLMClassification(): void {
    const generation = ++this.detectGeneration;
    this.classifyCurrentTranscript(generation).catch((error) => {
      if (!this.settled) {
        this.settled = true;
        this.cleanup();
        this.rejectRun?.(error);
      }
    });
  }

  private async classifyCurrentTranscript(generation: number): Promise<void> {
    if (this.transcriptParts.length === 0 || this.settled) {
      return;
    }

    const result = await this.detect(this.joinTranscript(), generation);

    if (this.settled || generation !== this.detectGeneration) {
      return;
    }

    // Mirrors python classifier.py: a confident verdict is committed immediately,
    // while UNCERTAIN is treated as "wait for more evidence" — the LLM signals
    // it via the `postpone_termination` tool, and the silence/detection timers
    // bound how long we'll keep waiting.
    if (result.category !== AMDCategory.UNCERTAIN) {
      this.setVerdict(result);
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────────────────

  /**
   * Mirrors python `_resolve_classifier`.
   * - `LLM` instance: caller-owned, used as-is.
   * - string: construct a Cloud Inference LLM (AMD-owned).
   * - `undefined`: fall back to `session.llm`.
   */
  private resolveLLM(option?: LLM | string): { llm: LLM; owned: boolean } {
    if (option instanceof LLM) {
      return { llm: option, owned: false };
    }
    if (typeof option === 'string') {
      return { llm: this.constructInferenceLLM(option), owned: true };
    }
    const sessionLLM = this.session.llm;
    if (sessionLLM instanceof LLM) {
      return { llm: sessionLLM, owned: false };
    }
    throw new Error(
      'AMD: no LLM available. Either set LIVEKIT_API_KEY/LIVEKIT_API_SECRET for ' +
        'Cloud Inference or pass an LLM instance.',
    );
  }

  /**
   * Mirrors python `_InferenceSTT(stt) if isinstance(stt, str) else stt`.
   * - `STT` instance: caller-owned.
   * - string: AMD-owned Cloud Inference STT.
   * - `undefined`: listen to session-level STT events.
   */
  private resolveSTT(option?: STT | string): {
    stt: STT | undefined;
    owned: boolean;
  } {
    if (option instanceof STT) {
      return { stt: option, owned: false };
    }
    if (typeof option === 'string') {
      return { stt: this.constructInferenceSTT(option), owned: true };
    }
    return { stt: undefined, owned: false };
  }

  private constructInferenceLLM(model: string): LLM {
    return new inference.LLM({ model: model as LLMModels });
  }

  private constructInferenceSTT(model: string): STT {
    return new inference.STT({ model: model as STTModels });
  }

  private joinTranscript(): string {
    // Single-line join: the prompt's few-shot `Input:` examples are single-line.
    return this.transcriptParts.join(' ');
  }

  private setSpanAttributes(result: AMDPredictionEvent): void {
    this.span?.setAttribute(traceTypes.ATTR_AMD_CATEGORY, result.category);
    this.span?.setAttribute(traceTypes.ATTR_AMD_REASON, result.reason);
    this.span?.setAttribute(traceTypes.ATTR_AMD_IS_MACHINE, result.isMachine);
    this.span?.setAttribute(traceTypes.ATTR_AMD_SPEECH_DURATION, result.speechDurationMs);
    this.span?.setAttribute(traceTypes.ATTR_AMD_DELAY, result.delayMs);
    this.span?.setAttribute(traceTypes.ATTR_AMD_TRANSCRIPT, result.transcript);
  }

  /**
   * Builds two LLM tools — `save_prediction` (always) and `postpone_termination`
   * (until extensions exhausted) — and lets the LLM choose between committing
   * a verdict or extending the silence window.
   *
   * If the LLM returns plain JSON content instead of tool calls (e.g. mock
   * LLMs in tests, or providers that don't support `toolChoice='required'`),
   * we fall back to the pre-port JSON-content parsing path.
   */
  private async detect(transcript: string, generation: number): Promise<AMDPredictionEvent> {
    let savedResult: AMDPredictionEvent | undefined;

    // Stale-classification guard: if a newer transcript has bumped the
    // generation counter while this LLM call was in flight, tool side effects
    // (verdict capture, timer/budget mutation) must no-op so the in-flight
    // newer classification owns the state.
    const isStale = (): boolean => generation !== this.detectGeneration || this.settled;

    const savePrediction = tool({
      name: 'save_prediction',
      description: 'Save the AMD prediction to the verdict.',
      parameters: z.object({
        label: z.enum([
          AMDCategory.HUMAN,
          AMDCategory.MACHINE_IVR,
          AMDCategory.MACHINE_VM,
          AMDCategory.MACHINE_UNAVAILABLE,
          AMDCategory.UNCERTAIN,
        ]),
      }),
      execute: async ({ label }) => {
        if (isStale()) return 'stale';
        // Normalize via parseCategory: defends against a non-tool execution
        // path (or a misbehaving LLM) handing us an off-enum string.
        const normalized = parseCategory(label);
        if (normalized !== AMDCategory.UNCERTAIN) {
          savedResult = {
            type: 'amd_prediction',
            category: normalized,
            reason: 'llm',
            transcript,
            rawResponse: '',
            isMachine: isMachineCategory(normalized),
            speechDurationMs: this.computeSpeechDurationMs(),
            delayMs: this.computeDelayMs(),
          };
        }
        return 'saved';
      },
    });

    const postponeTermination = tool({
      name: 'postpone_termination',
      description:
        'Postpone the termination of the classification task. ' +
        'Use when the transcript is ambiguous and more audio is expected.',
      parameters: z.object({
        seconds: z.number().describe('Additional seconds to wait (max 10).'),
      }),
      execute: async ({ seconds }) => {
        if (isStale()) return 'stale';
        // Defend against malformed args (negative, NaN) — the manual
        // tool-call path here bypasses Zod schema validation, so a misbehaving
        // LLM could otherwise pass values that fire the timer on the next tick.
        const rawMs = Number(seconds) * 1000;
        const clampedMs = Number.isFinite(rawMs)
          ? Math.max(0, Math.min(rawMs, MAX_EXTENSION_MS))
          : 0;
        this.extensionCount += 1;
        this.clearTimer('silence');
        this.silenceTimer = setTimeout(() => {
          // Extension window expired without another postpone: open the silence
          // gate and re-run classification with the latest transcript. With
          // extensions now exhausted, postpone is no longer offered to the LLM,
          // forcing it to commit via save_prediction. Mirrors python
          // `_on_postpone_elapsed` — opens silence only, not the end-of-turn gate.
          this.silenceReached = true;
          this.scheduleLLMClassification();
          this.tryEmitResult();
        }, clampedMs);
        return `waiting ${(clampedMs / 1000).toFixed(1)}s for more audio`;
      },
    });

    const toolList: ToolContextEntry[] = [savePrediction];
    if (this.extensionCount < MAX_EXTENSIONS) {
      toolList.push(postponeTermination);
    }
    const toolCtx = new ToolContext(toolList);

    const chatCtx = new ChatContext();
    chatCtx.addMessage({ role: 'system', content: this.prompt });
    // Pass the raw transcript as the user message (mirrors python `_run`), so the
    // model treats it as the next "Input:" in the prompt's few-shot pattern.
    chatCtx.addMessage({ role: 'user', content: transcript });

    const stream = this.llm.chat({ chatCtx, toolCtx, toolChoice: 'required' });
    this.currentLLMStream = stream;
    const chunks: string[] = [];
    const toolCalls: FunctionCall[] = [];
    try {
      for await (const chunk of stream) {
        const delta = chunk.delta;
        if (!delta) continue;
        if (delta.content) {
          chunks.push(delta.content);
        }
        if (delta.toolCalls && delta.toolCalls.length > 0) {
          toolCalls.push(...delta.toolCalls);
        }
      }
    } finally {
      // Only clear if we still own it: a second classification could have
      // started and overwritten the field while we were iterating.
      if (this.currentLLMStream === stream) {
        this.currentLLMStream = undefined;
      }
    }
    const rawResponse = chunks.join('');

    // Execute tool calls (save_prediction populates `savedResult`,
    // postpone_termination mutates the silence timer and returns).
    for (const tc of toolCalls) {
      const fnTool = toolCtx.getFunctionTool(tc.name);
      if (!fnTool || !isFunctionTool(fnTool)) continue;
      let parsedArgs: unknown = {};
      try {
        parsedArgs = JSON.parse(tc.args);
      } catch {
        // ignore malformed args; the tool execute() will receive {}
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AMD tools are loosely typed
        await fnTool.execute(parsedArgs as any, {
          ctx: undefined as never,
          toolCallId: tc.callId,
          abortSignal: new AbortController().signal,
        });
      } catch (error) {
        this._log.warn({ 'lk.pii.error': error, toolName: tc.name }, 'AMD tool execution failed');
      }
    }

    if (savedResult) {
      return { ...savedResult, rawResponse };
    }

    // The LLM used the tool interface but did not commit a non-uncertain verdict
    // (it called save_prediction(uncertain) and/or postpone_termination). Mirror
    // python, which only ever acts on tool calls: return UNCERTAIN and do NOT
    // resurrect a verdict by parsing any free-text content the model emitted
    // alongside its tool calls.
    if (toolCalls.length > 0) {
      return {
        type: 'amd_prediction',
        category: AMDCategory.UNCERTAIN,
        reason: 'llm',
        transcript,
        rawResponse,
        isMachine: false,
        speechDurationMs: this.computeSpeechDurationMs(),
        delayMs: this.computeDelayMs(),
      };
    }

    // Fallback: plain-JSON content (legacy / non-tool LLM responses, e.g. mock
    // LLMs in tests or providers that ignore `toolChoice='required'`).
    const parsed = this.parseDetection(rawResponse);
    return {
      type: 'amd_prediction',
      ...parsed,
      transcript,
      rawResponse,
      isMachine: isMachineCategory(parsed.category),
      speechDurationMs: this.computeSpeechDurationMs(),
      delayMs: this.computeDelayMs(),
    };
  }

  private computeSpeechDurationMs(): number {
    if (this.speechStartedAt === undefined) {
      return 0;
    }
    const end = this.speechEndedAt ?? performance.now();
    return Math.ceil(Math.max(0, end - this.speechStartedAt));
  }

  private computeDelayMs(): number {
    if (this.speechEndedAt === undefined) {
      return 0;
    }
    return Math.ceil(Math.max(0, performance.now() - this.speechEndedAt));
  }

  private parseDetection(rawResponse: string): Pick<AMDPredictionEvent, 'category' | 'reason'> {
    const normalized = rawResponse.trim();
    const jsonStart = normalized.indexOf('{');
    const jsonEnd = normalized.lastIndexOf('}');
    const jsonChunk =
      jsonStart >= 0 && jsonEnd >= jsonStart
        ? normalized.slice(jsonStart, jsonEnd + 1)
        : normalized;

    try {
      const parsed = JSON.parse(jsonChunk) as { category?: string; reason?: string };
      return {
        category: parseCategory(parsed.category),
        reason: parsed.reason?.trim() || 'No reason provided.',
      };
    } catch {
      return {
        category: AMDCategory.UNCERTAIN,
        reason: normalized || 'Failed to parse AMD model response.',
      };
    }
  }
}
