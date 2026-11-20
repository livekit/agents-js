// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const outputItemSchema = z
  .object({
    type: z.enum(['message', 'web_search_call']),
    phase: z.string().nullish(),
    content: z
      .array(
        z
          .object({
            annotations: z.array(z.unknown()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** Provider metadata accumulated from completed Responses output items. */
export type ResponsesMetadata = {
  phase?: string | null;
  output?: unknown[];
};

/** Retain search results and annotated messages with their original item IDs and citation offsets. */
export function accumulateResponsesMetadata(
  previous: ResponsesMetadata,
  item: unknown,
): ResponsesMetadata {
  const parsed = outputItemSchema.safeParse(item);
  if (!parsed.success) return previous;
  const output = parsed.data;
  const hasSources =
    output.type === 'web_search_call' ||
    output.content?.some((part) => (part.annotations?.length ?? 0) > 0);
  if (!hasSources && output.phase === undefined) return previous;
  return {
    ...previous,
    ...(output.phase !== undefined ? { phase: output.phase } : {}),
    ...(hasSources ? { output: [...(previous.output ?? []), output] } : {}),
  };
}
