// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import type OpenAI from 'openai';
import { OpenAITool } from './tools.js';

export function toResponsesTool(
  tool: llm.Tool,
  strictToolSchema: boolean,
): OpenAI.Responses.Tool | undefined {
  if (llm.isFunctionTool(tool)) {
    const oaiParams = {
      type: 'function' as const,
      name: tool.name,
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
  }

  return tool instanceof OpenAITool
    ? (tool.toToolConfig() as unknown as OpenAI.Responses.Tool)
    : undefined;
}

export function toResponsesTools(
  toolCtx: llm.ToolContext,
  strictToolSchema: boolean,
): OpenAI.Responses.Tool[] | undefined {
  // Function tools are emitted first, followed by provider tools, each in registration order.
  const functionTools = Object.values(toolCtx.functionTools);
  const providerTools = toolCtx.flatten().filter((tool) => !llm.isFunctionTool(tool));
  const tools = [...functionTools, ...providerTools]
    .map((tool) => toResponsesTool(tool, strictToolSchema))
    .filter((tool): tool is OpenAI.Responses.Tool => tool !== undefined);

  return tools.length > 0 ? tools : undefined;
}
