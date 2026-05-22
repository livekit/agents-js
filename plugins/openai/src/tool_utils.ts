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
  const tools = toolCtx
    .flatten()
    .map((tool) => {
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

      if (tool instanceof OpenAITool) {
        return tool.toToolConfig() as unknown as OpenAI.Responses.Tool;
      }

      return undefined;
    })
    .filter((tool): tool is OpenAI.Responses.Tool => tool !== undefined);

  return tools.length > 0 ? tools : undefined;
}
