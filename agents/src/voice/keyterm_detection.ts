// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { TypedEventEmitter as TypedEmitter } from '@livekit/typed-emitter';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { LLM as InferenceLLM } from '../inference/index.js';
import { ChatContext, ChatMessage, type FunctionCall } from '../llm/chat_context.js';
import { LLM } from '../llm/llm.js';
import { type ToolContext, tool } from '../llm/tool_context.js';
import { log } from '../log.js';
import type { LLMMetrics } from '../metrics/base.js';
import type { STT } from '../stt/index.js';
import type { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, type ConversationItemAddedEvent } from './events.js';

export type KeytermsOptions = {
  /** Static keyterms applied wherever the STT accepts a term list. */
  keyterms?: string[];
  /** LLM-based keyterm extraction, for STTs that accept a term list. */
  keytermDetection?: KeytermDetectionOptions;
};

export type KeytermDetectionOptions = {
  /** Whether to run the background detector. Defaults to `false`. */
  enabled?: boolean;
  /** LLM used for extraction, or a model string resolved through the inference gateway. */
  llm?: LLM | string | null;
  /** Run a pass once per N user turns. Defaults to `1`. */
  turnInterval?: number;
  /** Cap on confirmed detected keyterms. Defaults to unlimited. */
  maxKeyterms?: number | null;
  /** Override the built-in extraction prompt. */
  instructions?: string | null;
  /** Milliseconds a single detection pass may run before it is dropped. Defaults to `10000`. */
  timeout?: number;
};

type ResolvedKeytermDetectionOptions = Required<KeytermDetectionOptions>;
type KeytermDetectorCallbacks = { metrics_collected: (metrics: LLMMetrics) => void };

const DETECTION_TIMEOUT = 10_000;
const PENDING_TTL = 3;
const MAX_TRANSCRIPT_MESSAGES = 12;
const DEFAULT_DETECTION_MODEL = 'google/gemma-4-31b-it';

const DEFAULT_KEYTERM_INSTRUCTIONS = `You maintain STT keyterms that bias a recognizer toward the correct spelling of distinctive words (names, places, companies, products, technical terms). Each turn, adjust them with one \`record_keyterms\` call.

A WRONG spelling biases the recognizer for the rest of the call with no recovery, so precision beats coverage: apply only a spelling you can CORROBORATE, and when unsure change nothing.

USER lines are raw STT - often wrong, and the same error recurs, so repetition is NOT proof a spelling is right. ASSISTANT lines are the agent's own writing: trust the agent's confident use of its OWN names (brands, staff, locations) and confirm those promptly - but an assistant merely echoing the user's sounds, or hedging about a spelling, does NOT corroborate.

CONFIRM a pending term only when corroborated by one of:
  1. a letter-by-letter spell-out the assistant then accepts WITHOUT reservation - confirm exactly those letters, appending nothing;
  2. the assistant's own confident use of that exact distinctive spelling;
  3. an explicit user correction ("no, not X - it's Y").
Recurrence alone never confirms.

HEDGE RULE: if after a spell-out or name read-back the assistant signals the letters may be off ("for now", "with that caveat", "may have that slightly off", "did I catch that?", "to be confirmed", "I don't want to guess", "double-check"), the spelling is unreliable - keep the term PENDING and never confirm it, EVEN IF the user replies "yes". Only a cleanly accepted spell-out confirms.

Never apply: a user-line word that sounds like a known term (it's that term misheard); a distinctive name glued to an ordinary word ("Blue Haven Hotel" - keep the bare name pending); an odd phrase only the user says and the assistant never adopts; a fragment left by an interruption; ordinary words or fillers.

Report only CHANGES; never re-list an applied term.
  - \`pending\`: a distinctive term seen but not yet corroborated;
  - \`confirm\`: a pending term that just met the bar above;
  - \`remove\`: only a spelling the user just corrected away. Applied terms are otherwise sticky.
If nothing meets the bar this turn, change nothing.`;

const recordKeyterms = tool({
  description: 'Update the STT keyterms based on the latest transcript.',
  parameters: z.object({
    pending: z.array(z.string()).describe('Distinctive terms seen but not yet trusted.'),
    confirm: z.array(z.string()).describe('Pending terms the transcript has now corroborated.'),
    remove: z.array(z.string()).describe('Only a spelling the user corrected away.'),
  }),
  execute: async () => undefined,
});

export function resolveDetection(
  config: KeytermDetectionOptions | null | undefined,
): ResolvedKeytermDetectionOptions {
  return {
    enabled: false,
    llm: null,
    turnInterval: 1,
    maxKeyterms: null,
    instructions: null,
    timeout: DETECTION_TIMEOUT,
    ...(config ?? {}),
  };
}

export function resolveKeytermsOptions(config: KeytermsOptions | null | undefined): {
  keyterms: string[];
  keytermDetection: ResolvedKeytermDetectionOptions;
} {
  return {
    keyterms: [...(config?.keyterms ?? [])],
    keytermDetection: resolveDetection(config?.keytermDetection),
  };
}

function resolveDetectionLLM(configured: LLM | string | null): LLM | undefined {
  if (configured instanceof LLM) return configured;
  const model = typeof configured === 'string' ? configured : DEFAULT_DETECTION_MODEL;
  try {
    return InferenceLLM.fromModelString(model);
  } catch (error) {
    log().warn({ model, error }, 'keyterm detection: could not create detection LLM; skipping');
    return undefined;
  }
}

export class KeytermDetector extends (EventEmitter as new () => TypedEmitter<KeytermDetectorCallbacks>) {
  private detection: ResolvedKeytermDetectionOptions;
  private maxKeyterms: number | null;
  private turnInterval: number;
  private instructions: string;
  private detectionTimeout: number;
  private staticTerms: string[];
  private detectedTerms: string[] = [];
  private pendingTerms = new Map<string, number>();
  private tick = 0;
  private stt?: STT;
  private llm?: LLM;
  private session?: AgentSession;
  private turnCount = 0;
  private detectTask?: Promise<void>;
  private detectTaskPending = false;

  constructor({
    staticKeyterms,
    options,
  }: {
    staticKeyterms?: string[];
    options?: KeytermDetectionOptions | null;
  } = {}) {
    super();
    this.detection = resolveDetection(options);
    this.maxKeyterms = this.detection.maxKeyterms;
    this.turnInterval = Math.max(1, this.detection.turnInterval);
    this.instructions = this.detection.instructions ?? DEFAULT_KEYTERM_INSTRUCTIONS;
    this.detectionTimeout = this.detection.timeout;
    this.staticTerms = Array.from(new Set(staticKeyterms ?? []));
    this.llm = this.detection.llm instanceof LLM ? this.detection.llm : undefined;
  }

  get keyterms(): string[] {
    return Array.from(new Set([...this.staticTerms, ...this.detectedTerms]));
  }

  get staticKeyterms(): string[] {
    return [...this.staticTerms];
  }

  setStaticKeyterms(terms: string[]): void {
    this.staticTerms = Array.from(new Set(terms));
    this.stt?._updateSessionKeyterms(this.keyterms);
  }

  start(session: AgentSession, stt: STT): void {
    if (stt !== this.stt) {
      this.stt = stt;
      if (this.keyterms.length > 0) {
        this.stt._updateSessionKeyterms(this.keyterms);
      }
    }

    if (!this.detection.enabled) return;

    if (!stt.capabilities.keyterms) {
      log().warn(
        { stt: stt.label },
        'keyterm detection is enabled but the STT does not support keyterms; skipping detection',
      );
      return;
    }

    const detectLLM = resolveDetectionLLM(this.detection.llm);
    if (!detectLLM) {
      log().warn('keyterm detection is enabled but no detection LLM is available; skipping');
      return;
    }

    this.llm = detectLLM;
    detectLLM.on('metrics_collected', this.forwardMetrics);
    this.session = session;
    this.turnCount = 0;
    session.on(AgentSessionEventTypes.ConversationItemAdded, this.onConversationItemAdded);
  }

  async close(): Promise<void> {
    this.llm?.off('metrics_collected', this.forwardMetrics);
    this.session?.off(AgentSessionEventTypes.ConversationItemAdded, this.onConversationItemAdded);
    this.session = undefined;
    if (this.detectTask) {
      await this.detectTask.catch(() => undefined);
      this.detectTask = undefined;
      this.detectTaskPending = false;
    }
  }

  private forwardMetrics = (metrics: LLMMetrics): void => {
    this.emit('metrics_collected', metrics);
  };

  private onConversationItemAdded = (ev: ConversationItemAddedEvent): void => {
    if (!this.session) return;
    const item = ev.item;
    if (!(item instanceof ChatMessage) || item.role !== 'user' || !item.textContent) return;

    this.turnCount += 1;
    if (this.turnCount % this.turnInterval !== 0) return;
    if (this.detectTaskPending) return;

    this.detectTaskPending = true;
    this.detectTask = this.runOnce(KeytermDetector.snapshot(this.session))
      .catch((error) => log().error({ error }, 'keyterm detection pass failed'))
      .finally(() => {
        this.detectTaskPending = false;
      });
  };

  static snapshot(session: AgentSession): ChatContext {
    return session.history.copy({
      excludeConfigUpdate: true,
      excludeFunctionCall: true,
      excludeHandoff: true,
      excludeEmptyMessage: true,
    });
  }

  async runOnce(chatCtx: ChatContext): Promise<void> {
    if (!(this.llm instanceof LLM)) return;

    const current: Array<[string, boolean]> = [
      ...this.staticTerms.map((term): [string, boolean] => [term, true]),
      ...this.detectedTerms.map((term): [string, boolean] => [term, true]),
      ...Array.from(this.pendingTerms.keys()).map((term): [string, boolean] => [term, false]),
    ];
    const [pending, confirm, remove] = await detectKeyterms(this.llm, chatCtx, {
      currentKeyterms: current,
      instructions: this.instructions,
      timeout: this.detectionTimeout,
    });

    const before = this.keyterms;
    this.tick += 1;

    for (const term of remove) {
      this.pendingTerms.delete(term);
      this.detectedTerms = this.detectedTerms.filter((t) => t !== term);
    }

    for (const term of pending) {
      if (
        term &&
        !this.staticTerms.includes(term) &&
        !this.detectedTerms.includes(term) &&
        !this.pendingTerms.has(term)
      ) {
        this.pendingTerms.set(term, this.tick);
      }
    }

    for (const term of confirm) {
      if (term && !this.staticTerms.includes(term)) {
        this.pendingTerms.delete(term);
        if (!this.detectedTerms.includes(term)) this.detectedTerms.push(term);
      }
    }

    for (const [term, since] of this.pendingTerms) {
      if (this.tick - since >= PENDING_TTL) this.pendingTerms.delete(term);
    }

    if (this.maxKeyterms !== null) {
      while (this.detectedTerms.length > this.maxKeyterms) this.detectedTerms.shift();
    }

    const newKeyterms = this.keyterms;
    if (!sameList(newKeyterms, before) && this.stt) {
      this.stt._updateSessionKeyterms(newKeyterms);
      log().debug(
        {
          added: newKeyterms.filter((term) => !before.includes(term)),
          removed: before.filter((term) => !newKeyterms.includes(term)),
        },
        'keyterms changed',
      );
    }
  }
}

export async function detectKeyterms(
  llm: LLM,
  chatCtx: ChatContext,
  options: {
    instructions?: string | null;
    currentKeyterms?: Array<[string, boolean]>;
    timeout?: number;
  } = {},
): Promise<[string[], string[], string[]]> {
  const userMsg = formatInput(chatCtx, options.currentKeyterms ?? []);
  if (userMsg === undefined) return [[], [], []];

  const reqCtx = ChatContext.empty();
  reqCtx.addMessage({
    role: 'system',
    content: options.instructions ?? DEFAULT_KEYTERM_INSTRUCTIONS,
  });
  reqCtx.addMessage({ role: 'user', content: userMsg });

  const stream = llm.chat({
    chatCtx: reqCtx,
    toolCtx: { record_keyterms: recordKeyterms } satisfies ToolContext,
    toolChoice: 'required',
  });
  const timeoutMs = options.timeout ?? DETECTION_TIMEOUT;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stream.close();
  }, timeoutMs);

  try {
    const toolCalls: FunctionCall[] = [];
    for await (const chunk of stream) {
      if (chunk.delta?.toolCalls) toolCalls.push(...chunk.delta.toolCalls);
    }
    const result = timedOut ? [[], [], []] : parseToolCall(toolCalls);
    if (timedOut) {
      log().warn({ timeout: timeoutMs }, 'keyterm detection: pass timed out; skipping');
    }
    return result as [string[], string[], string[]];
  } finally {
    clearTimeout(timer);
  }
}

export function formatInput(
  chatCtx: ChatContext,
  currentKeyterms: Array<[string, boolean]>,
): string | undefined {
  const turns: string[] = [];
  for (const item of [...chatCtx.items].reverse()) {
    if (!(item instanceof ChatMessage) || (item.role !== 'user' && item.role !== 'assistant')) {
      continue;
    }
    const text = item.textContent;
    if (text) {
      const body = text
        .split('\n')
        .filter((line) => line.trim())
        .join('\n');
      turns.push(`${item.role.toUpperCase()}: ${body}`);
      if (turns.length >= MAX_TRANSCRIPT_MESSAGES) break;
    }
  }
  if (turns.length === 0) return undefined;
  turns.reverse();

  const applied = currentKeyterms.filter(([, ok]) => ok).map(([term]) => term);
  const candidates = currentKeyterms.filter(([, ok]) => !ok).map(([term]) => term);
  return [
    `## Transcript (USER = raw STT, may be wrong; ASSISTANT = correct spelling)\n${turns.join('\n\n')}`,
    `## Applied keyterms (biasing the recognizer now)\n${applied.join(', ') || '(none)'}`,
    `## Candidate keyterms (seen, not yet applied)\n${candidates.join(', ') || '(none)'}`,
    'Update the keyterms from the latest turns, then call `record_keyterms` once.',
  ].join('\n\n');
}

export function parseToolCall(toolCalls: FunctionCall[]): [string[], string[], string[]] {
  const call = toolCalls.find((c) => c.name === 'record_keyterms');
  if (!call) return [[], [], []];
  try {
    const data = JSON.parse(call.args) as Record<string, unknown>;
    const terms = (key: string) =>
      Array.isArray(data[key])
        ? data[key].filter(
            (term): term is string => typeof term === 'string' && term.trim().length > 0,
          )
        : [];
    return [terms('pending'), terms('confirm'), terms('remove')];
  } catch {
    return [[], [], []];
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
