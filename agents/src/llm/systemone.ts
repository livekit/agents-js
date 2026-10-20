// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { APIError } from '../_exceptions.js';
import {
  ChoiceResult,
  type Decision,
  type DecisionResult,
  ProbabilityResult,
  ScoreResult,
} from './decisions.js';

const noulAnswerSchema = z.object({
  type: z.literal('noul'),
  noul: z.number(),
});

const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.number()),
  confidence: z.number().nullable().optional(),
});

const scoreAnswerSchema = z.object({
  type: z.literal('score'),
  score: z.number(),
  probabilities: z.record(z.coerce.number(), z.number()),
  legend: z.union([z.record(z.coerce.number(), z.string()), z.array(z.string())]),
  confidence: z.number().nullable().optional(),
});

const refusalAnswerSchema = z.object({ type: z.literal('refusal') });

export const answerSchema = z.discriminatedUnion('type', [
  noulAnswerSchema,
  choiceAnswerSchema,
  scoreAnswerSchema,
  refusalAnswerSchema,
]);

export type Answer = z.infer<typeof answerSchema>;

export const responseSchema = z.object({
  answers: z.record(z.unknown()),
  model: z.string().default(''),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().nullable().optional(),
      output_tokens: z.number().int().nonnegative().nullable().optional(),
    })
    .default({}),
  id: z.string().default(''),
});

export type Response = z.infer<typeof responseSchema>;

export function encodeQuestion(definition: Decision): Record<string, unknown> {
  const question: Record<string, unknown> = { instructions: definition.prompt };
  if (definition.kind === 'probability') {
    question.type = 'noul';
  } else if (definition.kind === 'choice') {
    Object.assign(question, { type: 'choice', criteria: definition.options });
  } else {
    Object.assign(question, { type: 'score', criteria: definition.levels });
  }
  return question;
}

export function decodeAnswer(answer: Answer): DecisionResult {
  if (answer.type === 'refusal') {
    throw new APIError('the model declined this decision', { retryable: false });
  }
  if (answer.type === 'noul') {
    return new ProbabilityResult({ value: answer.noul });
  }
  if (answer.type === 'choice') {
    return new ChoiceResult({
      value: answer.choice,
      probabilities: answer.probabilities,
      providerData: { confidence: answer.confidence ?? null },
    });
  }

  const legend = Array.isArray(answer.legend)
    ? Object.fromEntries(answer.legend.map((level, index) => [index, level]))
    : answer.legend;
  if (!sameKeys(legend, answer.probabilities)) {
    throw new APIError('score legend does not match distribution', { retryable: false });
  }
  return new ScoreResult({
    value: answer.score,
    probabilities: answer.probabilities,
    levels: Object.keys(legend)
      .map(Number)
      .sort((left, right) => left - right)
      .map((index) => legend[index]!),
    providerData: { confidence: answer.confidence ?? null },
  });
}

export function decodeAnswers(
  answers: Record<string, unknown>,
  { invalid = 'invalid decision answer' }: { invalid?: string } = {},
): { results: Record<string, DecisionResult>; errors: Record<string, string> } {
  const results: Record<string, DecisionResult> = {};
  const errors: Record<string, string> = {};
  for (const [name, raw] of Object.entries(answers)) {
    const parsed = answerSchema.safeParse(raw);
    if (!parsed.success) {
      errors[name] = invalid;
      continue;
    }
    try {
      results[name] = decodeAnswer(parsed.data);
    } catch (error) {
      if (error instanceof APIError) {
        errors[name] = error.message;
      } else if (error instanceof TypeError) {
        errors[name] = invalid;
      } else {
        throw error;
      }
    }
  }
  return { results, errors };
}

function sameKeys(left: Record<number, unknown>, right: Record<number, unknown>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
  );
}
