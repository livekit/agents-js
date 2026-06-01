// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { TrackKind } from '@livekit/rtc-node';
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import type { Span } from '@opentelemetry/api';
import { EventEmitter } from 'node:events';
import type { ReadableStream } from 'node:stream/web';
import { z } from 'zod';
import * as inference from '../inference/index.js';
import type { LLMModels, STTModels } from '../inference/index.js';
import { ChatContext } from '../llm/chat_context.js';
import type { FunctionCall } from '../llm/chat_context.js';
import { LLM, type LLMStream } from '../llm/llm.js';
import { isFunctionTool, tool } from '../llm/tool_context.js';
import type { ToolContext } from '../llm/tool_context.js';
import { log } from '../log.js';
import { STT, SpeechEventType, type SpeechStream } from '../stt/stt.js';
import { traceTypes, tracer } from '../telemetry/index.js';
import { Task, delay, isCloud, waitForTrackPublication } from '../utils.js';
import type { AgentSession } from './agent_session.js';
import {
  AgentSessionEventTypes,
  type UserInputTranscribedEvent,
  type UserStateChangedEvent,
} from './events.js';
import { setParticipantSpanAttributes } from './utils.js';

export enum AMDCategory {
  HUMAN = 'human',
  MACHINE_IVR = 'machine-ivr',
  MACHINE_VM = 'machine-vm',
  MACHINE_UNAVAILABLE = 'machine-unavailable',
  /**
   * A carrier-injected call-screening prompt — Google Pixel Call Screen,
   * iOS 18 Call Screening, or a similar service that intercepts the call
   * and asks the caller to identify themselves before reaching the human
   * owner. Distinct from MACHINE_VM because the callee is reachable; the
   * caller is being asked to record a brief identification.
   *
   * NOTE: intentionally NOT a member of `MACHINE_CATEGORIES`, so
   * `interruptOnMachine: true` does NOT auto-interrupt on screening.
   * Callers handling screening typically need to play a short
   * identification greeting in response, which an automatic interrupt
   * would cancel. `result.isMachine` still reads `true` for screening
   * verdicts, so consumers' "did a machine answer?" checks behave
   * intuitively.
   */
  MACHINE_SCREENING = 'machine-screening',
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
  /** If no final transcript arrives within this window, settle as MACHINE_UNAVAILABLE. */
  noSpeechTimeoutMs?: number;
  /** Hard ceiling for the entire detection. After this, settle with whatever evidence exists. */
  detectionTimeoutMs?: number;
  /** Speech longer than this is treated as machine-like (skips the short-greeting heuristic). */
  humanSpeechThresholdMs?: number;
  /** Silence after a short greeting before settling as HUMAN. */
  humanSilenceThresholdMs?: number;
  /** Silence after machine-like speech before opening the silence gate. */
  machineSilenceThresholdMs?: number;
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

const MAX_EXTENSIONS = 3;
const MAX_EXTENSION_MS = 10_000;

const DEFAULT_AMD_LLM_MODEL = 'google/gemini-3.1-flash-lite';
const DEFAULT_AMD_STT_MODEL = 'cartesia/ink-whisper';

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

// Categories that drive `interruptOnMachine` auto-interrupt logic.
// `MACHINE_SCREENING` is intentionally absent — see the enum doc.
const MACHINE_CATEGORIES: ReadonlySet<AMDCategory> = new Set([
  AMDCategory.MACHINE_IVR,
  AMDCategory.MACHINE_VM,
  AMDCategory.MACHINE_UNAVAILABLE,
]);

// Categories that count as "a machine answered" for `result.isMachine`.
// Includes `MACHINE_SCREENING` so consumers see screening as a machine
// event without it triggering auto-interrupt.
const MACHINE_RESULT_CATEGORIES: ReadonlySet<AMDCategory> = new Set([
  ...MACHINE_CATEGORIES,
  AMDCategory.MACHINE_SCREENING,
]);

const VALID_CATEGORIES: ReadonlySet<string> = new Set(Object.values(AMDCategory));

function isMachineCategory(category: AMDCategory): boolean {
  return MACHINE_CATEGORIES.has(category);
}

function isMachineResult(category: AMDCategory): boolean {
  return MACHINE_RESULT_CATEGORIES.has(category);
}

function parseCategory(raw: string | undefined): AMDCategory {
  return typeof raw === 'string' && VALID_CATEGORIES.has(raw)
    ? (raw as AMDCategory)
    : AMDCategory.UNCERTAIN;
}

const AMD_PROMPT = `You classify the start of a phone call.
Return strict JSON with keys "category" and "reason".
Valid categories: "human", "machine-ivr", "machine-vm", "machine-unavailable", "machine-screening", "uncertain".
- "human": a live person answered.
- "machine-ivr": an IVR, phone tree, or menu system answered. This includes call-screening prompts (e.g. "Please state your name and why you're calling").
- "machine-vm": a voicemail greeting or mailbox prompt answered.
- "machine-unavailable": the call reached an unavailable mailbox, failed mailbox, or generic machine state where no message should be left.
- "machine-screening": a carrier-injected call-screening prompt (Google Pixel Call Screen, iOS 18 Call Screening, or similar) asking the caller to identify themselves before reaching the human owner. Examples: "If you record your name and reason for calling, I'll see if this person is available.", "Please state your name and the reason for calling.", "Hi, the person you're calling is using a screening service from Google.", "After the tone, please say your name."
- "uncertain": not enough evidence yet.
Do not include markdown fences or extra text.`;

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
    `${modelKind} model ${modelName} hasn't been evaluated with our benchmark, ` +
      'it might not be compatible with amd. Set `suppressCompatibilityWarning: true` to silence this warning.',
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
  private readonly interruptOnMachine: boolean;
  private readonly noSpeechTimeoutMs: number;
  private readonly detectionTimeoutMs: number;
  private readonly humanSpeechThresholdMs: number;
  private readonly humanSilenceThresholdMs: number;
  private readonly machineSilenceThresholdMs: number;
  private readonly prompt: string;
  private readonly participantIdentity: string | undefined;

  // --- execution state (reset per run) ---
  private active = false;
  private settled = false;
  private transcriptParts: string[] = [];
  private verdictResult: AMDPredictionEvent | undefined;
  private machineSilenceReached = false;
  private speechStartedAt: number | undefined;
  private speechEndedAt: number | undefined;
  private detectGeneration = 0;
  private extensionCount = 0;

  private noSpeechTimer: ReturnType<typeof setTimeout> | undefined;
  private detectionTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimerTrigger: 'short_speech' | 'long_speech' | undefined;

  private sttStream: SpeechStream | undefined;
  private sttPumpTask: Task<void> | undefined;
  /**
   * Aborts pending {@link waitForTrackPublication} calls in
   * {@link gateNoSpeechTimer}. Without this the room-event listener can
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

    this.interruptOnMachine = options.interruptOnMachine ?? true;
    this.noSpeechTimeoutMs = options.noSpeechTimeoutMs ?? DEFAULT_NO_SPEECH_TIMEOUT_MS;
    this.detectionTimeoutMs = options.detectionTimeoutMs ?? DEFAULT_DETECTION_TIMEOUT_MS;
    this.humanSpeechThresholdMs = options.humanSpeechThresholdMs ?? HUMAN_SPEECH_THRESHOLD_MS;
    this.humanSilenceThresholdMs = options.humanSilenceThresholdMs ?? HUMAN_SILENCE_THRESHOLD_MS;
    this.machineSilenceThresholdMs =
      options.machineSilenceThresholdMs ?? MACHINE_SILENCE_THRESHOLD_MS;
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
            this.gateNoSpeechTimer();
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
        this._log.warn({ err: e }, 'AMD failed to close owned STT');
      }
    }
    if (this.llmOwned) {
      try {
        await this.llm.aclose();
      } catch (e) {
        this._log.warn({ err: e }, 'AMD failed to close owned LLM');
      }
    }
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────────

  private resetState(): void {
    this.settled = false;
    this.transcriptParts = [];
    this.verdictResult = undefined;
    this.machineSilenceReached = false;
    this.speechStartedAt = undefined;
    this.speechEndedAt = undefined;
    this.silenceTimerTrigger = undefined;
    this.detectGeneration = 0;
    this.extensionCount = 0;
    this.resolveRun = undefined;
    this.rejectRun = undefined;
  }

  private subscribe(): void {
    this.session.on(AgentSessionEventTypes.UserInputTranscribed, this.handleTranscript);
    this.session.on(AgentSessionEventTypes.UserStateChanged, this.handleUserStateChanged);
    this.session.on(AgentSessionEventTypes.Close, this.handleClose);
  }

  /**
   * The detection timer is the hard ceiling on the entire run and starts as
   * soon as `execute()` is called — even before the participant audio track is
   * published — so a stuck/never-published track cannot make AMD hang forever.
   */
  private startDetectionTimer(): void {
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

  /**
   * If the session has a `_roomIO`, defer the no-speech timer until the
   * participant's audio track is both published and subscribed. Without
   * `_roomIO` (e.g. unit tests, remote-session callers without participants),
   * fall back to starting the timer immediately.
   */
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
      this._log.warn({ err }, 'AMD dedicated STT pump exited with error');
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
          const text = event.alternatives?.[0]?.text?.trim();
          if (!text) continue;
          this.consumeTranscript(text);
        }
      } catch (err) {
        if (this.settled) return;
        this._log.debug({ err }, 'AMD dedicated STT receive pump error');
      }
    })();

    await Promise.allSettled([sendPump, recvPump]);
  }

  private gateNoSpeechTimer(): void {
    const roomIO = this.session._roomIO;
    const room = roomIO?.rtcRoom;
    if (!room || !room.isConnected) {
      // Mirrors python: "session room_io unavailable, starting amd timers
      // immediately as fallback".
      this.startNoSpeechTimer();
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
      .then(() => {
        if (!this.settled) {
          this.startNoSpeechTimer();
        }
      })
      .catch((err) => {
        // Track gating is best-effort: if waiting for publication fails (e.g.
        // room disconnected, aborted by `cleanup`, or the function rejects),
        // fall back to starting the timer so the run still settles within
        // `noSpeechTimeoutMs`.
        this._log.debug({ err }, 'AMD track gating failed; starting no-speech timer immediately');
        if (!this.settled) {
          this.startNoSpeechTimer();
        }
      });
  }

  private cleanup(): void {
    this.clearTimer('noSpeech');
    this.clearTimer('detection');
    this.clearTimer('silence');
    this.session.off(AgentSessionEventTypes.UserInputTranscribed, this.handleTranscript);
    this.session.off(AgentSessionEventTypes.UserStateChanged, this.handleUserStateChanged);
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

  private clearTimer(name: 'noSpeech' | 'detection' | 'silence'): void {
    const key = `${name}Timer` as 'noSpeechTimer' | 'detectionTimer' | 'silenceTimer';
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
   * Ref: python classifier.py `_try_emit_result` — emits only when both
   * `verdictResult` is set AND `machineSilenceReached` is true.
   */
  private tryEmitResult(): void {
    if (!this.verdictResult || !this.machineSilenceReached || this.settled) {
      return;
    }
    this.clearTimer('detection');
    this.finish(this.verdictResult);
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
        transcript: result.transcript,
      },
      'amd prediction',
    );
    // Auto-interrupt gates on `isMachineCategory`, NOT `result.isMachine`,
    // so MACHINE_SCREENING does not trigger auto-interrupt — callers
    // handling screening typically need to play a short identification
    // greeting in response, which an automatic interrupt would cancel.
    if (isMachineCategory(result.category) && this.interruptOnMachine) {
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
      this._log.debug({ err }, 'AMD: session host failed to handle amd_prediction');
    }
    this.emit('amd_prediction', result);
  }

  // ─── timer callbacks ─────────────────────────────────────────────────────────

  /**
   * Ref: python classifier.py `_silence_timer_callback` — fires when a silence
   * threshold expires. Optionally provides a verdict (for no-speech / timeout /
   * short-greeting paths) and always opens the silence gate.
   */
  private onSilenceTimerFired(category?: AMDCategory, reason?: string): void {
    this.clearTimer('silence');
    if (category && reason && !this.verdictResult) {
      this.setVerdict({
        type: 'amd_prediction',
        category,
        reason,
        transcript: this.joinTranscript(),
        rawResponse: '',
        isMachine: isMachineResult(category),
        speechDurationMs: this.computeSpeechDurationMs(),
        delayMs: this.computeDelayMs(),
      });
    }
    this.machineSilenceReached = true;
    this.tryEmitResult();
  }

  private settleNoSpeech(): void {
    this.onSilenceTimerFired(AMDCategory.MACHINE_UNAVAILABLE, 'no_speech_timeout');
  }

  private settleDetectionTimeout(): void {
    this.onSilenceTimerFired(AMDCategory.UNCERTAIN, 'detection_timeout');
  }

  // ─── event handlers (arrow properties for stable `on`/`off` references) ─────

  /**
   * Ref: python classifier.py `on_user_speech_started` / `on_user_speech_ended` —
   * VAD-driven speech boundaries control the silence gate and short-greeting heuristic.
   */
  private readonly handleUserStateChanged = (ev: UserStateChangedEvent): void => {
    if (this.settled) {
      return;
    }

    if (ev.newState === 'speaking') {
      this.clearTimer('silence');
      this.clearTimer('noSpeech');
      if (this.speechStartedAt === undefined) {
        this.speechStartedAt = ev.createdAt;
      }
      this.machineSilenceReached = false;
      return;
    }

    if (ev.newState !== 'listening' || ev.oldState !== 'speaking') {
      return;
    }

    const speechDurationMs = ev.createdAt - (this.speechStartedAt ?? ev.createdAt);
    this.speechEndedAt = ev.createdAt;

    this.clearTimer('silence');

    // Short greeting: speech ≤ humanSpeechThreshold AND no transcript yet → HUMAN (skip LLM)
    // When transcript is available, defer to LLM and use the longer machine_silence_threshold
    // so the classifier can review the words before settling.
    if (speechDurationMs <= this.humanSpeechThresholdMs) {
      if (this.transcriptParts.length === 0) {
        this.silenceTimer = setTimeout(
          () => this.onSilenceTimerFired(AMDCategory.HUMAN, 'short_greeting'),
          this.humanSilenceThresholdMs,
        );
        this.silenceTimerTrigger = 'short_speech';
      } else {
        this.silenceTimer = setTimeout(
          () => this.onSilenceTimerFired(),
          this.machineSilenceThresholdMs,
        );
        this.silenceTimerTrigger = 'long_speech';
      }
      return;
    }

    // Longer speech: open silence gate after machine_silence_threshold of quiet
    this.silenceTimer = setTimeout(
      () => this.onSilenceTimerFired(),
      this.machineSilenceThresholdMs,
    );
    this.silenceTimerTrigger = 'long_speech';
  };

  /**
   * Session-level transcript handler. Mirrors python `_AMDClassifier.push_text`'s
   * source filtering: when AMD has its own dedicated STT we ignore session-level
   * events entirely (the dedicated pump in {@link runSTTPump} drives transcripts
   * via {@link consumeTranscript}); when no dedicated STT is configured we
   * consume session events as the only transcript source.
   */
  private readonly handleTranscript = (ev: UserInputTranscribedEvent): void => {
    if (this.stt) return;
    if (!ev.isFinal) return;
    const transcript = ev.transcript.trim();
    if (!transcript) return;
    this.consumeTranscript(transcript);
  };

  /**
   * Shared transcript ingestion: cancels the no-speech timer, refreshes the
   * silence-gate target if we were on the short-greeting path, and fires off
   * an LLM classification on the accumulated transcript.
   */
  private consumeTranscript(transcript: string): void {
    if (this.settled) return;
    if (this.silenceTimer && this.silenceTimerTrigger === 'short_speech') {
      this.clearTimer('silence');
      if (this.speechEndedAt !== undefined) {
        const remaining = Math.max(
          0,
          this.speechEndedAt + this.machineSilenceThresholdMs - Date.now(),
        );
        this.silenceTimer = setTimeout(() => this.onSilenceTimerFired(), remaining);
        this.silenceTimerTrigger = 'long_speech';
      }
    }

    this.clearTimer('noSpeech');
    this.transcriptParts.push(transcript);
    this.scheduleLLMClassification();
  }

  private readonly handleClose = (): void => {
    this.onSilenceTimerFired(AMDCategory.UNCERTAIN, 'session_closed');
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
    return this.transcriptParts.join('\n');
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
          // forcing it to commit via save_prediction.
          this.machineSilenceReached = true;
          this.scheduleLLMClassification();
          this.tryEmitResult();
        }, clampedMs);
        return `waiting ${(clampedMs / 1000).toFixed(1)}s for more audio`;
      },
    });

    const toolCtx: ToolContext = { save_prediction: savePrediction };
    if (this.extensionCount < MAX_EXTENSIONS) {
      toolCtx.postpone_termination = postponeTermination;
    }

    const chatCtx = new ChatContext();
    chatCtx.addMessage({ role: 'system', content: this.prompt });
    chatCtx.addMessage({
      role: 'user',
      content: `Transcript:\n${transcript}\n\nClassify this call answer.`,
    });

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
      const fnTool = toolCtx[tc.name];
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
          abortSignal: undefined as unknown as AbortSignal,
        });
      } catch (error) {
        this._log.warn({ error, toolName: tc.name }, 'AMD tool execution failed');
      }
    }

    if (savedResult) {
      return { ...savedResult, rawResponse };
    }

    // Fallback: plain-JSON content (legacy / non-tool LLM responses).
    const parsed = this.parseDetection(rawResponse);
    return {
      type: 'amd_prediction',
      ...parsed,
      transcript,
      rawResponse,
      isMachine: isMachineResult(parsed.category),
      speechDurationMs: this.computeSpeechDurationMs(),
      delayMs: this.computeDelayMs(),
    };
  }

  private computeSpeechDurationMs(): number {
    if (this.speechStartedAt === undefined) {
      return 0;
    }
    const end = this.speechEndedAt ?? Date.now();
    return Math.max(0, end - this.speechStartedAt);
  }

  private computeDelayMs(): number {
    if (this.speechEndedAt === undefined) {
      return 0;
    }
    return Math.max(0, Date.now() - this.speechEndedAt);
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
