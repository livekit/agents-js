// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Span } from '@opentelemetry/api';
import { ChatContext } from '../llm/chat_context.js';
import { LLM } from '../llm/llm.js';
import { traceTypes, tracer } from '../telemetry/index.js';
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
  UNCERTAIN = 'uncertain',
}

export interface AMDResult {
  category: AMDCategory;
  transcript: string;
  reason: string;
  rawResponse: string;
  isMachine: boolean;
}

export interface AMDOptions {
  llm?: LLM;
  interruptOnMachine?: boolean;
  /** If no final transcript arrives within this window, settle as MACHINE_UNAVAILABLE. */
  noSpeechTimeoutMs?: number;
  /** Hard ceiling for the entire detection. After this, settle with whatever evidence exists. */
  detectionTimeoutMs?: number;
  maxTranscriptTurns?: number;
}

// Ref: python classifier.py constants — thresholds for VAD-based heuristics and timeouts
const HUMAN_SPEECH_THRESHOLD_MS = 2_500;
const HUMAN_SILENCE_THRESHOLD_MS = 500;
const MACHINE_SILENCE_THRESHOLD_MS = 1_500;
const DEFAULT_NO_SPEECH_TIMEOUT_MS = 10_000;
const DEFAULT_DETECTION_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TRANSCRIPT_TURNS = 2;

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

const AMD_PROMPT = `You classify the start of a phone call.
Return strict JSON with keys "category" and "reason".
Valid categories: "human", "machine-ivr", "machine-vm", "machine-unavailable", "uncertain".
- "human": a live person answered.
- "machine-ivr": an IVR, phone tree, or menu system answered.
- "machine-vm": a voicemail greeting or mailbox prompt answered.
- "machine-unavailable": the call reached an unavailable mailbox, failed mailbox, or generic machine state where no message should be left.
- "uncertain": not enough evidence yet.
Do not include markdown fences or extra text.`;

/**
 * Answering Machine Detection.
 *
 * Mirrors Python's `_AMDClassifier` two-gate architecture:
 * a result is only emitted when both a **verdict** (from LLM or heuristic) and
 * a **silence gate** (from VAD or timeout) are satisfied.
 */
export class AMD {
  private readonly llm: LLM;
  private readonly interruptOnMachine: boolean;
  private readonly noSpeechTimeoutMs: number;
  private readonly detectionTimeoutMs: number;
  private readonly maxTranscriptTurns: number;

  // --- execution state (reset per run) ---
  private active = false;
  private settled = false;
  private transcriptParts: string[] = [];
  private verdictResult: AMDResult | undefined;
  private machineSilenceReached = false;
  private speechStartedAt: number | undefined;
  private detectGeneration = 0;

  private noSpeechTimer: ReturnType<typeof setTimeout> | undefined;
  private detectionTimer: ReturnType<typeof setTimeout> | undefined;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;

  private resolveRun: ((value: AMDResult) => void) | undefined;
  private rejectRun: ((reason?: unknown) => void) | undefined;
  private span: Span | undefined;

  constructor(
    private readonly session: AgentSession,
    options: AMDOptions = {},
  ) {
    const llm = options.llm ?? this.resolveSessionLLM();
    if (!llm) {
      throw new Error(
        'AMD requires an LLM. Pass `options.llm` when the session is not using a pipeline LLM.',
      );
    }

    this.llm = llm;
    this.interruptOnMachine = options.interruptOnMachine ?? true;
    this.noSpeechTimeoutMs = options.noSpeechTimeoutMs ?? DEFAULT_NO_SPEECH_TIMEOUT_MS;
    this.detectionTimeoutMs = options.detectionTimeoutMs ?? DEFAULT_DETECTION_TIMEOUT_MS;
    this.maxTranscriptTurns = options.maxTranscriptTurns ?? DEFAULT_MAX_TRANSCRIPT_TURNS;
  }

  // ─── public API ──────────────────────────────────────────────────────────────

  async execute(): Promise<AMDResult> {
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
          const result = await new Promise<AMDResult>((resolve, reject) => {
            this.resolveRun = resolve;
            this.rejectRun = reject;
            this.subscribe();
            this.startTimers();
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
    this.cleanup();
    this.session.resumeReplyAuthorization();
    this.active = false;
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────────

  private resetState(): void {
    this.settled = false;
    this.transcriptParts = [];
    this.verdictResult = undefined;
    this.machineSilenceReached = false;
    this.speechStartedAt = undefined;
    this.detectGeneration = 0;
    this.resolveRun = undefined;
    this.rejectRun = undefined;
  }

  private subscribe(): void {
    this.session.on(AgentSessionEventTypes.UserInputTranscribed, this.handleTranscript);
    this.session.on(AgentSessionEventTypes.UserStateChanged, this.handleUserStateChanged);
    this.session.on(AgentSessionEventTypes.Close, this.handleClose);
  }

  private startTimers(): void {
    // Ref: python classifier.py start() — two independent timers
    this.noSpeechTimer = setTimeout(() => this.settleNoSpeech(), this.noSpeechTimeoutMs);
    this.detectionTimer = setTimeout(() => this.settleDetectionTimeout(), this.detectionTimeoutMs);
  }

  private cleanup(): void {
    this.clearTimer('noSpeech');
    this.clearTimer('detection');
    this.clearTimer('silence');
    this.session.off(AgentSessionEventTypes.UserInputTranscribed, this.handleTranscript);
    this.session.off(AgentSessionEventTypes.UserStateChanged, this.handleUserStateChanged);
    this.session.off(AgentSessionEventTypes.Close, this.handleClose);
  }

  private clearTimer(name: 'noSpeech' | 'detection' | 'silence'): void {
    const key = `${name}Timer` as 'noSpeechTimer' | 'detectionTimer' | 'silenceTimer';
    if (this[key]) {
      clearTimeout(this[key]);
      this[key] = undefined;
    }
  }

  // ─── two-gate emit system (verdict + silence) ───────────────────────────────

  /**
   * Ref: python classifier.py `_set_verdict` — stores the LLM/heuristic verdict.
   * Emission is deferred until the silence gate also opens.
   */
  private setVerdict(result: AMDResult): void {
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

  private finish(result: AMDResult): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.cleanup();
    this.setSpanAttributes(result);
    if (result.isMachine && this.interruptOnMachine) {
      this.session.interrupt({ force: true }).await.catch(() => {});
    }
    this.resolveRun?.(result);
  }

  // ─── timer callbacks ─────────────────────────────────────────────────────────

  /**
   * Ref: python classifier.py `_silence_timer_callback` — fires when a silence
   * threshold expires. Optionally provides a verdict (for no-speech / timeout /
   * short-greeting paths) and always opens the silence gate.
   */
  private onSilenceTimerFired(category?: AMDCategory, reason?: string): void {
    if (category && reason && !this.verdictResult) {
      this.setVerdict({
        category,
        reason,
        transcript: this.joinTranscript(),
        rawResponse: '',
        isMachine: isMachineCategory(category),
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

    this.clearTimer('silence');

    // Short greeting: speech ≤ 2.5s + 0.5s silence → HUMAN (skip LLM)
    if (speechDurationMs <= HUMAN_SPEECH_THRESHOLD_MS) {
      this.silenceTimer = setTimeout(
        () => this.onSilenceTimerFired(AMDCategory.HUMAN, 'short_greeting'),
        HUMAN_SILENCE_THRESHOLD_MS,
      );
      return;
    }

    // Longer speech: open silence gate after 1.5s of quiet
    this.silenceTimer = setTimeout(() => this.onSilenceTimerFired(), MACHINE_SILENCE_THRESHOLD_MS);
  };

  /**
   * Ref: python classifier.py `push_text` — cancels the no-speech timer and
   * feeds transcript text to the LLM classifier.
   */
  private readonly handleTranscript = (ev: UserInputTranscribedEvent): void => {
    if (!ev.isFinal) {
      return;
    }
    const transcript = ev.transcript.trim();
    if (!transcript) {
      return;
    }

    this.clearTimer('noSpeech');
    this.transcriptParts.push(transcript);
    this.scheduleLLMClassification();
  };

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

    const result = await this.detect(this.joinTranscript());

    if (this.settled || generation !== this.detectGeneration) {
      return;
    }

    if (
      result.category !== AMDCategory.UNCERTAIN ||
      this.transcriptParts.length >= this.maxTranscriptTurns
    ) {
      this.setVerdict(result);
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────────────────

  private resolveSessionLLM(): LLM | undefined {
    return this.session.llm instanceof LLM ? this.session.llm : undefined;
  }

  private joinTranscript(): string {
    return this.transcriptParts.join('\n');
  }

  private setSpanAttributes(result: AMDResult): void {
    this.span?.setAttribute(traceTypes.ATTR_AMD_CATEGORY, result.category);
    this.span?.setAttribute(traceTypes.ATTR_AMD_REASON, result.reason);
    this.span?.setAttribute(traceTypes.ATTR_AMD_IS_MACHINE, result.isMachine);
    this.span?.setAttribute(traceTypes.ATTR_USER_TRANSCRIPT, result.transcript);
  }

  private async detect(transcript: string): Promise<AMDResult> {
    const chatCtx = new ChatContext();
    chatCtx.addMessage({ role: 'system', content: AMD_PROMPT });
    chatCtx.addMessage({
      role: 'user',
      content: `Transcript:\n${transcript}\n\nClassify this call answer.`,
    });

    const stream = this.llm.chat({ chatCtx });
    const chunks: string[] = [];
    for await (const chunk of stream) {
      const content = chunk.delta?.content;
      if (content) {
        chunks.push(content);
      }
    }
    const rawResponse = chunks.join('');

    const parsed = this.parseDetection(rawResponse);
    return {
      ...parsed,
      transcript,
      rawResponse,
      isMachine: isMachineCategory(parsed.category),
    };
  }

  private parseDetection(rawResponse: string): Pick<AMDResult, 'category' | 'reason'> {
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
