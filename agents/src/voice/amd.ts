// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Span } from '@opentelemetry/api';
import { z } from 'zod';
import { ChatContext } from '../llm/chat_context.js';
import type { FunctionCall } from '../llm/chat_context.js';
import { LLM } from '../llm/llm.js';
import { isFunctionTool, tool } from '../llm/tool_context.js';
import type { ToolContext } from '../llm/tool_context.js';
import { log } from '../log.js';
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
  /** Speech longer than this is treated as machine-like (skips the short-greeting heuristic). */
  humanSpeechThresholdMs?: number;
  /** Silence after a short greeting before settling as HUMAN. */
  humanSilenceThresholdMs?: number;
  /** Silence after machine-like speech before opening the silence gate. */
  machineSilenceThresholdMs?: number;
  /** Override the AMD classification system prompt. */
  prompt?: string;
  /**
   * Restricts span attribution to a specific participant identity. Currently
   * informational only — the JS AMD listens to session-level events, not a
   * specific participant track.
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
const DEFAULT_MAX_TRANSCRIPT_TURNS = 2;

const MAX_EXTENSIONS = 3;
const MAX_EXTENSION_MS = 10_000;

const EVALUATED_LLM_MODELS: ReadonlySet<string> = new Set([
  'google/gemini-3.1-flash-lite-preview',
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
- "machine-ivr": an IVR, phone tree, or menu system answered. This includes call-screening prompts (e.g. "Please state your name and why you're calling").
- "machine-vm": a voicemail greeting or mailbox prompt answered.
- "machine-unavailable": the call reached an unavailable mailbox, failed mailbox, or generic machine state where no message should be left.
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
 */
export class AMD {
  private readonly llm: LLM;
  private readonly interruptOnMachine: boolean;
  private readonly noSpeechTimeoutMs: number;
  private readonly detectionTimeoutMs: number;
  private readonly maxTranscriptTurns: number;
  private readonly humanSpeechThresholdMs: number;
  private readonly humanSilenceThresholdMs: number;
  private readonly machineSilenceThresholdMs: number;
  private readonly prompt: string;
  private readonly participantIdentity: string | undefined;

  // --- execution state (reset per run) ---
  private active = false;
  private settled = false;
  private transcriptParts: string[] = [];
  private verdictResult: AMDResult | undefined;
  private machineSilenceReached = false;
  private speechStartedAt: number | undefined;
  private detectGeneration = 0;
  private extensionCount = 0;

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
    this.humanSpeechThresholdMs = options.humanSpeechThresholdMs ?? HUMAN_SPEECH_THRESHOLD_MS;
    this.humanSilenceThresholdMs = options.humanSilenceThresholdMs ?? HUMAN_SILENCE_THRESHOLD_MS;
    this.machineSilenceThresholdMs =
      options.machineSilenceThresholdMs ?? MACHINE_SILENCE_THRESHOLD_MS;
    this.prompt = options.prompt ?? AMD_PROMPT;
    this.participantIdentity = options.participantIdentity;

    if (!options.suppressCompatibilityWarning) {
      warnIfNotEvaluated(this.llm.model, EVALUATED_LLM_MODELS, 'llm');
    }
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
    // Mark settled before rejecting so any in-flight `detect()` call sees
    // `isStale()` return true and its tool callbacks no-op. Without this,
    // a postpone_termination resolved after aclose could install a fresh
    // silenceTimer that survives cleanup and triggers session.interrupt.
    this.settled = true;
    if (this.active && this.rejectRun) {
      this.rejectRun(new Error('AMD closed'));
    }
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────────

  private resetState(): void {
    this.settled = false;
    this.transcriptParts = [];
    this.verdictResult = undefined;
    this.machineSilenceReached = false;
    this.speechStartedAt = undefined;
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

  private startTimers(): void {
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

    // Short greeting: speech ≤ humanSpeechThreshold AND no transcript yet → HUMAN (skip LLM)
    // When transcript is available, defer to LLM and use the longer machine_silence_threshold
    // so the classifier can review the words before settling.
    if (speechDurationMs <= this.humanSpeechThresholdMs) {
      if (this.transcriptParts.length === 0) {
        this.silenceTimer = setTimeout(
          () => this.onSilenceTimerFired(AMDCategory.HUMAN, 'short_greeting'),
          this.humanSilenceThresholdMs,
        );
      } else {
        this.silenceTimer = setTimeout(
          () => this.onSilenceTimerFired(),
          this.machineSilenceThresholdMs,
        );
      }
      return;
    }

    // Longer speech: open silence gate after machine_silence_threshold of quiet
    this.silenceTimer = setTimeout(
      () => this.onSilenceTimerFired(),
      this.machineSilenceThresholdMs,
    );
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

    const result = await this.detect(this.joinTranscript(), generation);

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

  /**
   * Builds two LLM tools — `save_prediction` (always) and `postpone_termination`
   * (until extensions exhausted) — and lets the LLM choose between committing
   * a verdict or extending the silence window.
   *
   * If the LLM returns plain JSON content instead of tool calls (e.g. mock
   * LLMs in tests, or providers that don't support `toolChoice='required'`),
   * we fall back to the pre-port JSON-content parsing path.
   */
  private async detect(transcript: string, generation: number): Promise<AMDResult> {
    let savedResult: AMDResult | undefined;

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
            category: normalized,
            reason: 'llm',
            transcript,
            rawResponse: '',
            isMachine: isMachineCategory(normalized),
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
    const chunks: string[] = [];
    const toolCalls: FunctionCall[] = [];
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
        log().warn({ error, toolName: tc.name }, 'AMD tool execution failed');
      }
    }

    if (savedResult) {
      return { ...savedResult, rawResponse };
    }

    // Fallback: plain-JSON content (legacy / non-tool LLM responses).
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
