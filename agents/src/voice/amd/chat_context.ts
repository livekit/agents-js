// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** AMD turn bookkeeping and independent classifier history. */
import {
  ChatContext,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
} from '../../llm/chat_context.js';
import type { AMDCategory, AMDPredictionEvent } from './events.js';

export type AMDTranscriptSource = 'session' | 'amd';

const HISTORY_LIMIT = 20;
export const AGENT_REPLY = '(the agent spoke)';

/** A turn's transcript from each STT; `null` for an STT that is not in use. */
export class AMDTranscript {
  constructor(
    readonly session: string | null,
    readonly amd: string | null = null,
  ) {}

  /** The one transcript for events and the Agent: the session's, else AMD's. */
  get transcript(): string {
    return this.session || this.amd || '';
  }

  /**
   * Both transcripts when AMD has its own STT, so neither has to win a race.
   *
   * Encoded as JSON: as bare labeled lines, the classifier stopped reading a
   * lone "Hi." as only a greeting word.
   */
  forClassifier(): string {
    if (this.session === null || this.amd === null) {
      return this.transcript;
    }
    return pythonJsonDumps({ transcript_1: this.session, transcript_2: this.amd });
  }
}

export interface Turn {
  turnId: number;
  /** Monotonic commit time in milliseconds. */
  committedAt: number;
  transcript: AMDTranscript;
  /** User speech in this turn, in milliseconds. */
  speechDuration: number;
  prediction: AMDPredictionEvent | null;
  /** Classification time in milliseconds. */
  inferenceDuration: number | null;
}

/** Conversation snapshot and constraints for one classification. */
export interface AMDRequest {
  readonly stage: AMDCategory;
  readonly recommendedNextCategories: AMDCategory[];
  readonly previousPrediction: AMDPredictionEvent | null;
  readonly chatCtx: ChatContext;
  /** User speech in this turn, in milliseconds. */
  readonly speechDuration: number;
}

/** A thin wrapper to track only user transcript and DTMF events. */
export class AMDChatContext extends ChatContext {
  addTranscript(turn: Turn): void {
    this.addMessage({
      role: 'user',
      content: turn.transcript.forClassifier(),
      extra: { turn_id: turn.turnId },
    });
  }

  /**
   * Mark that the agent spoke, never its words, at the time its speech started.
   *
   * The session adds a reply when its speech ends, so a participant turn committed
   * during that speech can arrive first. Inserting by start time keeps speaking order.
   */
  addAgentReply(startedAt: number): void {
    this.insert(
      ChatMessage.create({ role: 'assistant', content: [AGENT_REPLY], createdAt: startedAt }),
    );
  }

  addToolResult(call: FunctionCall, output: FunctionCallOutput): void {
    if (
      call.name !== 'send_dtmf_events' ||
      output.isError ||
      !output.output ||
      this.getById(call.id) !== undefined
    ) {
      return;
    }
    this.items.push(FunctionCall.create({ ...call }), FunctionCallOutput.create({ ...output }));
  }

  createRequest(
    turn: Turn,
    {
      stage,
      recommended,
      previousPrediction,
    }: {
      stage: AMDCategory;
      recommended: AMDCategory[];
      previousPrediction: AMDPredictionEvent | null;
    },
  ): AMDRequest {
    return {
      stage,
      recommendedNextCategories: recommended,
      previousPrediction: previousPrediction ? { ...previousPrediction } : null,
      // Python's truncate keeps a context within the limit as is, leading DTMF calls included
      chatCtx: (this.items.length > HISTORY_LIMIT ? this.truncate(HISTORY_LIMIT) : this).copy(),
      speechDuration: turn.speechDuration,
    };
  }
}

/** A number that {@link pythonJsonDumps} writes like a Python float (`1.0`, not `1`). */
export class PythonFloat {
  constructor(readonly value: number) {}
}

/**
 * `JSON.stringify` with Python `json.dumps` defaults: `", "` and `": "` separators and
 * non-ASCII characters escaped. The classifier prompt was tuned on Python's encoding.
 */
export function pythonJsonDumps(value: unknown): string {
  return stringify(value).replace(
    /[\u0080-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function stringify(value: unknown): string {
  if (value instanceof PythonFloat) {
    return Number.isInteger(value.value) ? value.value.toFixed(1) : String(value.value);
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stringify).join(', ')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${stringify(v)}`).join(', ')}}`;
}
