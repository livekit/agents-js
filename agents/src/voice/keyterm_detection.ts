// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { LLM as InferenceLLM } from '../inference/llm.js';
import { ChatContext, ChatMessage, type FunctionCall } from '../llm/chat_context.js';
import { LLM } from '../llm/llm.js';
import { tool } from '../llm/tool_context.js';
import { log } from '../log.js';
import type { LLMMetrics } from '../metrics/base.js';
import type { STT } from '../stt/stt.js';
import { Task, delay } from '../utils.js';
import { AgentSessionEventTypes, type ConversationItemAddedEvent } from './events.js';

/**
 * Keyterm biasing for STTs that accept a term list.
 *
 * @deprecated Use {@link STTContextOptions} (`new AgentSession({ sttContextOptions: ... })`)
 * instead; its `keyterms` and `keytermDetection` keys are identical.
 */
export interface KeytermsOptions {
  /** Static keyterms applied wherever the STT accepts a term list; never touched by detection. */
  keyterms?: string[];
  /** LLM-based keyterm extraction, for STTs that accept a term list. */
  keytermDetection?: KeytermDetectionOptions;
}

/**
 * Configuration for automatic keyterm detection.
 *
 * Lives under the `keytermDetection` key of {@link KeytermsOptions}. Absent or
 * `{ enabled: false }` keeps detection off.
 */
export interface KeytermDetectionOptions {
  /** Whether to run the background detector. Defaults to `false`. */
  enabled?: boolean;
  /**
   * LLM used for extraction. An `LLM` instance, or a model string (e.g.
   * `"google/gemini-3.5-flash"`) resolved via the inference gateway. Defaults to a
   * built-in detection model; the agent's own LLM is not used.
   */
  llm?: LLM | string;
  /** Run a pass once per N user turns. Defaults to `1`. */
  turnInterval?: number;
  /** Cap on the confirmed (applied) detected keyterms if provided. Defaults to `undefined`. */
  maxKeyterms?: number;
  /** Override the built-in extraction prompt. */
  instructions?: string;
  /**
   * Milliseconds a single detection pass may run before it is dropped (no keyterm change).
   * Defaults to `10_000`. Raise it if a slow detection `llm` needs longer.
   */
  timeout?: number;
}

/**
 * Conversation-aware context for the STT.
 *
 * Can be passed as a plain object:
 *
 * ```ts
 * new AgentSession({
 *   sttContextOptions: {
 *     keyterms: ['LiveKit', 'Acme Corp'],
 *     keytermDetection: { enabled: true, turnInterval: 1 },
 *     forwardChatContext: true,
 *   },
 * });
 * ```
 */
export interface STTContextOptions {
  /** Static keyterms applied wherever the STT accepts a term list; never touched by detection. */
  keyterms?: string[];
  /** LLM-based keyterm extraction, for STTs that accept a term list. */
  keytermDetection?: KeytermDetectionOptions;
  /**
   * Forward conversation turns to STTs that consume context directly (e.g. AssemblyAI U3 Pro).
   * Defaults to `true`; only STTs that advertise the `chatContext` capability act on it.
   */
  forwardChatContext?: boolean;
}

// bound a single pass so a stuck LLM call can't hold the single-flight guard forever and
// stall detection for the rest of the call; a timed-out pass simply makes no change
const DETECTION_TIMEOUT = 10_000;

const KEYTERM_DETECTION_DEFAULTS = {
  enabled: false,
  llm: undefined,
  turnInterval: 1,
  maxKeyterms: undefined,
  instructions: undefined,
  timeout: DETECTION_TIMEOUT,
} as const;

/** A fully-defaulted keyterm-detection config. @internal */
export interface ResolvedKeytermDetectionOptions {
  enabled: boolean;
  llm?: LLM | string;
  turnInterval: number;
  maxKeyterms?: number;
  instructions?: string;
  timeout: number;
}

/** A fully-defaulted STT-context config. @internal */
export interface ResolvedSTTContextOptions {
  keyterms: string[];
  keytermDetection: ResolvedKeytermDetectionOptions;
  forwardChatContext: boolean;
}

/** A pending term not confirmed within this many passes is dropped. @internal */
export const PENDING_TTL = 3;
const MAX_TRANSCRIPT_MESSAGES = 12;

// default model for keyterm extraction when `keytermDetection.llm` is not set
const DEFAULT_DETECTION_MODEL = 'google/gemma-4-31b-it';

// set LK_KEYTERMS_DEBUG=1 to log the input/output of every detection pass
const lkKeytermsDebug = parseInt(process.env.LK_KEYTERMS_DEBUG ?? '0', 10) !== 0;

/** Return a fully-defaulted keyterm-detection config (`enabled` defaults to false). @internal */
export function resolveDetection(
  config?: KeytermDetectionOptions,
): ResolvedKeytermDetectionOptions {
  const merged = { ...KEYTERM_DETECTION_DEFAULTS, ...(config ?? {}) };
  return {
    enabled: merged.enabled ?? false,
    llm: merged.llm,
    turnInterval: merged.turnInterval ?? 1,
    maxKeyterms: merged.maxKeyterms,
    instructions: merged.instructions,
    timeout: merged.timeout ?? DETECTION_TIMEOUT,
  };
}

/** Return a fully-defaulted STT-context config. @internal */
export function resolveSTTContextOptions(config?: STTContextOptions): ResolvedSTTContextOptions {
  const cfg = config ?? {};
  return {
    keyterms: [...(cfg.keyterms ?? [])],
    keytermDetection: resolveDetection(cfg.keytermDetection),
    forwardChatContext: cfg.forwardChatContext ?? true,
  };
}

/** Map deprecated `keytermsOptions` onto the new {@link STTContextOptions} shape. @internal */
export function sttContextFromKeytermsOptions(config?: KeytermsOptions): STTContextOptions {
  const out: STTContextOptions = {};
  if (config?.keyterms !== undefined) {
    out.keyterms = config.keyterms;
  }
  if (config?.keytermDetection !== undefined) {
    out.keytermDetection = config.keytermDetection;
  }
  return out;
}

/**
 * Resolve the configured detection `llm`: an `LLM` instance is used directly; a
 * model string (or the default model when unset) is created via the inference gateway.
 */
function resolveDetectionLLM(configured?: LLM | string): LLM | undefined {
  if (configured instanceof LLM) {
    return configured;
  }
  const model = typeof configured === 'string' ? configured : DEFAULT_DETECTION_MODEL;
  try {
    return InferenceLLM.fromModelString(model);
  } catch {
    // never let detection setup break the session
    log().warn(`keyterm detection: could not create detection LLM ${model}; skipping`);
    return undefined;
  }
}

const DEFAULT_KEYTERM_INSTRUCTIONS = `\
You maintain STT keyterms that bias a recognizer toward the correct spelling of distinctive \
words (names, places, companies, products, technical terms). Each turn, adjust them with one \
\`record_keyterms\` call.

A WRONG spelling biases the recognizer for the rest of the call with no recovery, so precision \
beats coverage: apply only a spelling you can CORROBORATE, and when unsure change nothing.

USER lines are raw STT — often wrong, and the same error recurs, so repetition is NOT proof a \
spelling is right. ASSISTANT lines are the agent's own writing: trust the agent's confident use \
of its OWN names (brands, staff, locations) and confirm those promptly — but an assistant merely \
echoing the user's sounds, or hedging about a spelling, does NOT corroborate.

CONFIRM a pending term only when corroborated by one of:
  1. a letter-by-letter spell-out the assistant then accepts WITHOUT reservation — confirm \
exactly those letters, appending nothing;
  2. the assistant's own confident use of that exact distinctive spelling;
  3. an explicit user correction ("no, not X — it's Y").
Recurrence alone never confirms.

HEDGE RULE: if after a spell-out or name read-back the assistant signals the letters may be off \
("for now", "with that caveat", "may have that slightly off", "did I catch that?", "to be \
confirmed", "I don't want to guess", "double-check"), the spelling is unreliable — keep the term \
PENDING and never confirm it, EVEN IF the user replies "yes". Only a cleanly accepted spell-out \
confirms.

Never apply: a user-line word that sounds like a known term (it's that term misheard); a \
distinctive name glued to an ordinary word ("Blue Haven Hotel" — keep the bare name pending); an \
odd phrase only the user says and the assistant never adopts; a fragment left by an interruption; \
ordinary words or fillers.

Report only CHANGES; never re-list an applied term.
  - \`pending\`: a distinctive term seen but not yet corroborated;
  - \`confirm\`: a pending term that just met the bar above;
  - \`remove\`: only a spelling the user just corrected away. Applied terms are otherwise sticky.
If nothing meets the bar this turn, change nothing.`;

// only used to elicit a structured tool call; never executed
const recordKeyterms = tool({
  name: 'record_keyterms',
  description: 'Update the STT keyterms based on the latest transcript.',
  parameters: z.object({
    pending: z
      .array(z.string())
      .describe('Distinctive terms seen but not yet trusted — tracked, not applied.'),
    confirm: z
      .array(z.string())
      .describe('Pending terms the transcript has now corroborated — applied.'),
    remove: z
      .array(z.string())
      .describe('Only a spelling the user corrected away; applied terms are otherwise sticky.'),
  }),
  execute: async () => {},
});

/**
 * The minimal session surface the detector needs. `AgentSession` satisfies this
 * structurally; tests can supply a lightweight fake.
 *
 */
export interface KeytermDetectorSession {
  readonly history: ChatContext;
  on(
    event: AgentSessionEventTypes.ConversationItemAdded,
    listener: (ev: ConversationItemAddedEvent) => void,
  ): unknown;
  off(
    event: AgentSessionEventTypes.ConversationItemAdded,
    listener: (ev: ConversationItemAddedEvent) => void,
  ): unknown;
}

export type KeytermDetectorCallbacks = {
  ['metrics_collected']: (metrics: LLMMetrics) => void;
};

/**
 * Maintains the STT keyterm set and, when enabled, auto-detects keyterms during a call.
 *
 * Owned by the {@link AgentSession} so keyterm state survives agent handoffs. Each agent
 * activity binds it to that activity's STT via {@link KeytermDetector.start} and releases it via
 * {@link KeytermDetector.aclose}. When detection is on, an LLM extracts distinctive spellings from
 * the conversation; only confirmed terms are pushed to the STT, while pending terms are tracked
 * (and fed back to the detector) without biasing recognition.
 */
export class KeytermDetector extends (EventEmitter as new () => TypedEmitter<KeytermDetectorCallbacks>) {
  private detection: ResolvedKeytermDetectionOptions;
  private maxKeyterms?: number;
  private turnInterval: number;
  private instructions: string;
  private detectionTimeout: number;

  private staticTerms: string[];
  /** confirmed terms, oldest first (for eviction) @internal */
  _detectedTerms: string[] = [];
  /** term -> pass it was added (for TTL) @internal */
  _pendingTerms: Map<string, number> = new Map();
  private tick = 0; // detection-pass counter

  // bound per agent activity (see start/aclose)
  private stt?: STT;
  private llm?: LLM;
  private session?: KeytermDetectorSession;
  private turnCount = 0;
  /** @internal */
  _detectTask?: Task<void>;

  #logger = log();

  constructor(opts?: { staticKeyterms?: string[]; options?: KeytermDetectionOptions }) {
    super();
    const options = resolveDetection(opts?.options);
    this.detection = options;
    this.maxKeyterms = options.maxKeyterms;
    this.turnInterval = Math.max(1, options.turnInterval);
    this.instructions = options.instructions ?? DEFAULT_KEYTERM_INSTRUCTIONS;
    this.detectionTimeout = options.timeout;

    this.staticTerms = [...new Set(opts?.staticKeyterms ?? [])];
    this.llm = options.llm instanceof LLM ? options.llm : undefined;
  }

  /** The effective list applied to the STT: static terms + confirmed detected terms. */
  get keyterms(): string[] {
    return [...new Set([...this.staticTerms, ...this._detectedTerms])];
  }

  get staticKeyterms(): string[] {
    return [...this.staticTerms];
  }

  setStaticKeyterms(terms: string[]): void {
    this.staticTerms = [...new Set(terms)];
    if (this.stt !== undefined) {
      this.stt._updateSessionKeyterms(this.keyterms);
    }
  }

  /** Bind this activity's STT (always) and start detection (if enabled). */
  start(session: KeytermDetectorSession, stt: STT): void {
    // static keyterms must reach the recognizer even with detection disabled
    if (stt !== this.stt) {
      this.stt = stt;
      // push even an empty list to a keyterm-capable STT: a reused instance may
      // still hold session keyterms from a previous detector binding
      if (this.keyterms.length > 0 || stt.capabilities.keyterms) {
        this.stt._updateSessionKeyterms(this.keyterms);
      }
    }

    if (!this.detection.enabled) {
      return;
    }

    // don't waste LLM detection passes when no STT can consume the keyterms
    if (!stt.capabilities.keyterms) {
      this.#logger
        .child({ stt: stt.label })
        .warn(
          'keyterm detection is enabled but the STT does not support keyterms; skipping detection',
        );
      return;
    }

    const detectLLM = resolveDetectionLLM(this.detection.llm);
    if (detectLLM === undefined) {
      this.#logger.warn('keyterm detection is enabled but no detection LLM is available; skipping');
      return;
    }

    this.llm = detectLLM;
    detectLLM.on('metrics_collected', this.forwardMetrics);
    this.session = session;
    this.turnCount = 0;
    session.on(AgentSessionEventTypes.ConversationItemAdded, this.onConversationItemAdded);
  }

  /** Stop detection for the current activity; keyterm state is kept. */
  async aclose(): Promise<void> {
    if (this.llm !== undefined) {
      this.llm.off('metrics_collected', this.forwardMetrics);
    }
    if (this.session !== undefined) {
      this.session.off(AgentSessionEventTypes.ConversationItemAdded, this.onConversationItemAdded);
      this.session = undefined;
    }
    if (this._detectTask !== undefined) {
      await this._detectTask.cancelAndWait();
      this._detectTask = undefined;
    }
  }

  private forwardMetrics = (ev: LLMMetrics): void => {
    this.emit('metrics_collected', ev);
  };

  private onConversationItemAdded = (ev: ConversationItemAddedEvent): void => {
    const session = this.session;
    if (session === undefined) {
      return;
    }

    const item = ev.item;
    // keyterm detection triggers on non-empty user turns
    if (!(item instanceof ChatMessage) || item.role !== 'user' || !item.textContent) {
      return;
    }

    this.turnCount += 1;
    if (this.turnCount % this.turnInterval !== 0) {
      return;
    }

    // single-flight: skip while a pass is still running
    if (this._detectTask !== undefined && !this._detectTask.done) {
      return;
    }

    // snapshot the transcript now so the pass isn't affected by later turns
    const snapshot = KeytermDetector.snapshot(session);
    this._detectTask = Task.from(async (controller) => {
      try {
        await this.runOnce(snapshot, controller.signal);
      } catch (error) {
        this.#logger.child({ error }).error('keyterm detection pass failed');
        throw error;
      }
    });
    // fire-and-forget: failures are logged above; keep the task awaitable without unhandled rejections
    this._detectTask.result.catch(() => {});
  };

  private static snapshot(session: KeytermDetectorSession): ChatContext {
    return session.history.copy({
      excludeConfigUpdate: true,
      excludeFunctionCall: true,
      excludeHandoff: true,
      excludeEmptyMessage: true,
    });
  }

  /** @internal exposed for tests */
  async runOnce(chatCtx: ChatContext, abortSignal?: AbortSignal): Promise<void> {
    if (!(this.llm instanceof LLM)) {
      return;
    }

    // show static terms as applied too, or the LLM keeps re-proposing them
    const current: [string, boolean][] = [
      ...this.staticTerms.map((t): [string, boolean] => [t, true]),
      ...this._detectedTerms.map((t): [string, boolean] => [t, true]),
      ...[...this._pendingTerms.keys()].map((t): [string, boolean] => [t, false]),
    ];
    const [pending, confirm, remove] = await detectKeyterms(this.llm, chatCtx, {
      currentKeyterms: current,
      instructions: this.instructions,
      timeout: this.detectionTimeout,
      abortSignal,
    });

    // cancelled mid-flight (e.g. activity shutdown): don't touch keyterm state
    if (abortSignal?.aborted) {
      return;
    }

    const before = this.keyterms;
    this.tick += 1;

    // update the keyterm state
    for (const term of remove) {
      this._pendingTerms.delete(term);
      const idx = this._detectedTerms.indexOf(term);
      if (idx !== -1) {
        this._detectedTerms.splice(idx, 1);
      }
    }

    for (const term of pending) {
      // track a new candidate; ignore static terms and ones already known
      if (term && !this.staticTerms.includes(term)) {
        if (!this._detectedTerms.includes(term) && !this._pendingTerms.has(term)) {
          this._pendingTerms.set(term, this.tick);
        }
      }
    }

    for (const term of confirm) {
      if (term && !this.staticTerms.includes(term)) {
        this._pendingTerms.delete(term); // promote out of pending
        if (!this._detectedTerms.includes(term)) {
          this._detectedTerms.push(term);
        }
      }
    }

    // drop pending terms that were never confirmed in time
    for (const [term, addedAt] of [...this._pendingTerms.entries()]) {
      if (this.tick - addedAt >= PENDING_TTL) {
        this._pendingTerms.delete(term);
      }
    }

    // evict oldest confirmed terms if over the cap
    if (this.maxKeyterms !== undefined) {
      while (this._detectedTerms.length > this.maxKeyterms) {
        this._detectedTerms.shift();
      }
    }

    // update the STT if the keyterms changed
    const newKeyterms = this.keyterms;
    if (
      this.stt !== undefined &&
      (newKeyterms.length !== before.length || newKeyterms.some((t, i) => t !== before[i]))
    ) {
      this.stt._updateSessionKeyterms(newKeyterms);
      const beforeSet = new Set(before);
      const newSet = new Set(newKeyterms);
      this.#logger
        .child({
          added: newKeyterms.filter((t) => !beforeSet.has(t)),
          removed: before.filter((t) => !newSet.has(t)),
        })
        .debug('keyterms changed');
    }
  }
}

/**
 * Run one extraction pass via a forced function call.
 *
 * Returns `[pending, confirm, remove]`.
 *
 * @internal exposed for tests
 */
export async function detectKeyterms(
  llm: LLM,
  chatCtx: ChatContext,
  opts?: {
    instructions?: string;
    currentKeyterms?: [string, boolean][];
    timeout?: number;
    abortSignal?: AbortSignal;
  },
): Promise<[string[], string[], string[]]> {
  const current = opts?.currentKeyterms ?? [];
  const timeout = opts?.timeout ?? DETECTION_TIMEOUT;
  const abortSignal = opts?.abortSignal;
  if (abortSignal?.aborted) {
    return [[], [], []];
  }
  const userMsg = formatInput(chatCtx, current);
  if (userMsg === undefined) {
    // no transcript yet — nothing to detect
    return [[], [], []];
  }
  const reqCtx = ChatContext.empty();
  reqCtx.addMessage({
    role: 'system',
    content: opts?.instructions ?? DEFAULT_KEYTERM_INSTRUCTIONS,
  });
  reqCtx.addMessage({ role: 'user', content: userMsg });

  const stream = llm.chat({ chatCtx: reqCtx, toolCtx: [recordKeyterms], toolChoice: 'required' });
  const timedOut = Symbol('keyterm-detection-timeout');
  const timeoutController = new AbortController();
  const timeoutPromise: Promise<typeof timedOut> = delay(timeout, {
    signal: timeoutController.signal,
  }).then(
    () => timedOut,
    () => timedOut, // aborted: the collect() already won the race
  );
  // cancellation parity with Python: closing the stream ends its output queue,
  // which unblocks collect() immediately instead of waiting out the LLM request
  const onAbort = () => stream.close();
  abortSignal?.addEventListener('abort', onAbort, { once: true });
  let raced: Awaited<ReturnType<typeof stream.collect>> | typeof timedOut;
  try {
    raced = await Promise.race([stream.collect(), timeoutPromise]);
  } finally {
    timeoutController.abort();
    abortSignal?.removeEventListener('abort', onAbort);
  }
  if (abortSignal?.aborted) {
    return [[], [], []];
  }
  if (raced === timedOut) {
    stream.close();
    log().warn(`keyterm detection: pass timed out after ${timeout}ms; skipping`);
    return [[], [], []];
  }
  const result = parseToolCall(raced.toolCalls);

  if (lkKeytermsDebug) {
    debugDump(userMsg, result);
  }
  return result;
}

/**
 * Render the detector's user message: recent transcript + current keyterms.
 *
 * Returns `undefined` when the transcript holds no user/assistant text yet.
 *
 * @internal exposed for tests
 */
export function formatInput(
  chatCtx: ChatContext,
  currentKeyterms: [string, boolean][],
): string | undefined {
  // walk newest-first and stop once we have enough, then restore chronological order
  const turns: string[] = [];
  for (let i = chatCtx.items.length - 1; i >= 0; i--) {
    const item = chatCtx.items[i]!;
    if (!(item instanceof ChatMessage) || (item.role !== 'user' && item.role !== 'assistant')) {
      continue;
    }
    const text = item.textContent;
    if (text) {
      // keep the message's line structure but drop blank lines, so the blank line
      // between turns is the only blank line and reliably marks a turn boundary
      const body = text
        .split('\n')
        .filter((line) => line.trim())
        .join('\n');
      turns.push(`${item.role.toUpperCase()}: ${body}`);
      if (turns.length >= MAX_TRANSCRIPT_MESSAGES) {
        break;
      }
    }
  }
  if (turns.length === 0) {
    return undefined;
  }
  turns.reverse();

  const applied = currentKeyterms.filter(([, ok]) => ok).map(([term]) => term);
  const candidates = currentKeyterms.filter(([, ok]) => !ok).map(([term]) => term);
  // always show both lists (even empty) so the model has explicit state to diff against
  const sections = [
    '## Transcript (USER = raw STT, may be wrong; ASSISTANT = correct spelling)\n' +
      turns.join('\n\n'), // blank line between turns
    '## Applied keyterms (biasing the recognizer now)\n' + (applied.join(', ') || '(none)'),
    '## Candidate keyterms (seen, not yet applied)\n' + (candidates.join(', ') || '(none)'),
    'Update the keyterms from the latest turns, then call `record_keyterms` once.',
  ];
  return sections.join('\n\n'); // blank line + ## heading between sections
}

/**
 * Parse the `record_keyterms` tool call into `[pending, confirm, remove]`.
 *
 * @internal exposed for tests
 */
export function parseToolCall(toolCalls: FunctionCall[]): [string[], string[], string[]] {
  const fnc = toolCalls.find((c) => c.name === 'record_keyterms');
  if (fnc === undefined) {
    return [[], [], []];
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fnc.args);
  } catch {
    return [[], [], []];
  }

  const terms = (key: string): string[] => {
    const value = data[key];
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
  };

  return [terms('pending'), terms('confirm'), terms('remove')];
}

/** Log the input/output of one detection pass (gated by `LK_KEYTERMS_DEBUG`). */
function debugDump(userMsg: string, result: [string[], string[], string[]]): void {
  const [pending, confirm, remove] = result;
  log().debug(
    [
      '──────── keyterm detection ────────',
      userMsg,
      '──── output ────',
      `pending: ${JSON.stringify(pending)}`,
      `confirm: ${JSON.stringify(confirm)}`,
      `remove:  ${JSON.stringify(remove)}`,
      '───────────────────────────────────',
    ].join('\n'),
  );
}
