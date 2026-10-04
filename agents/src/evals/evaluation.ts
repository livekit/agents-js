// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext } from '../llm/chat_context.js';
import type { LLM } from '../llm/llm.js';
import { log } from '../log.js';
import { type Evaluator, JudgmentResult } from './judge.js';

const evalsVerbose = parseInt(process.env.LIVEKIT_EVALS_VERBOSE || '0', 10);

/**
 * Result of evaluating a conversation with a group of judges.
 */
export class EvaluationResult {
  /** Individual judgment results keyed by judge name. */
  readonly judgments: Record<string, JudgmentResult>;

  constructor(judgments: Record<string, JudgmentResult> = {}) {
    this.judgments = judgments;
  }

  /** Score from 0.0 to 1.0. Pass=1, maybe=0.5, fail=0. */
  get score(): number {
    const results = Object.values(this.judgments);
    if (results.length === 0) return 0;
    const total = results.reduce((sum, j) => sum + (j.passed ? 1 : j.uncertain ? 0.5 : 0), 0);
    return total / results.length;
  }

  /** True if all judgments passed. Maybes count as not passed. */
  get allPassed(): boolean {
    return Object.values(this.judgments).every((j) => j.passed);
  }

  /** True if at least one judgment passed. */
  get anyPassed(): boolean {
    return Object.values(this.judgments).some((j) => j.passed);
  }

  /** True if more than half of the judgments passed. */
  get majorityPassed(): boolean {
    const results = Object.values(this.judgments);
    if (results.length === 0) return true;
    return results.filter((j) => j.passed).length > results.length / 2;
  }

  /** True if no judgments explicitly failed. Maybes are allowed. */
  get noneFailed(): boolean {
    return !Object.values(this.judgments).some((j) => j.failed);
  }
}

/** Options for {@link JudgeGroup}. */
export interface JudgeGroupOptions {
  /** The LLM used by judges that were not constructed with their own LLM. */
  llm: LLM;
  /** The judges to run during evaluation. */
  judges?: Evaluator[];
}

/**
 * A group of judges that evaluate conversations together.
 *
 * @example
 * ```typescript
 * const judges = new evals.JudgeGroup({
 *   llm: new inference.LLM({ model: 'openai/gpt-4o-mini' }),
 *   judges: [evals.taskCompletionJudge(), evals.accuracyJudge()],
 * });
 * const result = await judges.evaluate(session.history);
 * console.log(result.score, result.allPassed);
 * ```
 */
export class JudgeGroup {
  private readonly _llm: LLM;
  private readonly _judges: Evaluator[];

  constructor({ llm, judges = [] }: JudgeGroupOptions) {
    this._llm = llm;
    this._judges = judges;
  }

  /** The LLM used for evaluation. */
  get llm(): LLM {
    return this._llm;
  }

  /** The judges to run during evaluation. */
  get judges(): Evaluator[] {
    return this._judges;
  }

  /**
   * Evaluate a conversation with all judges concurrently.
   *
   * A judge that throws is logged and left out of the result.
   *
   * @param chatCtx - The conversation to evaluate.
   * @param options - Optional reference conversation for comparison.
   */
  async evaluate(
    chatCtx: ChatContext,
    options: { reference?: ChatContext } = {},
  ): Promise<EvaluationResult> {
    const results = await Promise.all(
      this._judges.map(async (judge): Promise<[string, JudgmentResult | Error]> => {
        try {
          const result = await judge.evaluate({
            chatCtx,
            reference: options.reference,
            llm: this._llm,
          });
          return [judge.name, result];
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          log().warn(`Judge '${judge.name}' failed: ${error.message}`);
          return [judge.name, error];
        }
      }),
    );

    const judgments: Record<string, JudgmentResult> = {};
    for (const [name, result] of results) {
      if (result instanceof JudgmentResult) {
        judgments[name] = result;
      }
    }

    if (evalsVerbose) {
      console.log('\n+ JudgeGroup evaluation results:');
      for (const [name, result] of results) {
        if (result instanceof JudgmentResult) {
          console.log(`  [${name}] verdict=${result.verdict}`);
          console.log(`    reasoning: ${result.reasoning}\n`);
        } else {
          console.log(`  [${name}] ERROR: ${result.message}\n`);
        }
      }
    }

    return new EvaluationResult(judgments);
  }
}
