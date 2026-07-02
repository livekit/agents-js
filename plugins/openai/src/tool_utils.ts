// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import type OpenAI from 'openai';
import { OpenAITool } from './tools.js';

export function toResponsesTools(
  toolCtx: llm.ToolContext,
  strictToolSchema: boolean,
): OpenAI.Responses.Tool[] | undefined {
  // Function tools are emitted first, sorted by name for deterministic payloads; provider
  // tools follow in registration order.
  const functionTools = llm.sortedToolEntries(toolCtx).map(([name, tool]) => {
    const oaiParams = {
      type: 'function' as const,
      name,
      description: tool.description,
      parameters: llm.toJsonSchema(
        tool.parameters,
        true,
        strictToolSchema,
      ) as unknown as OpenAI.Responses.FunctionTool['parameters'],
    } as OpenAI.Responses.FunctionTool;

    if (strictToolSchema) {
      oaiParams.strict = true;
    }

    return oaiParams;
  });

  const providerTools = toolCtx
    .flatten()
    .filter((tool) => !llm.isFunctionTool(tool))
    .map((tool) =>
      tool instanceof OpenAITool
        ? (tool.toToolConfig() as unknown as OpenAI.Responses.Tool)
        : undefined,
    )
    .filter((tool): tool is OpenAI.Responses.Tool => tool !== undefined);

  const tools = [...functionTools, ...providerTools];

  return tools.length > 0 ? tools : undefined;
}
