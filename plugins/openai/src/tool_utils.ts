// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, log } from '@livekit/agents';
import type OpenAI from 'openai';
import { OpenAITool } from './tools.js';

/**
 * Provider-tool class accepted by {@link toResponsesTools}. Subclasses of the
 * Responses LLM (e.g. xAI) pass their own plugin tool base so tools that are
 * not `OpenAITool` still serialize. Matches Python `provider_tool_type`.
 */
export type ResponsesProviderToolType = abstract new (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- plugin tool constructors take plugin-specific option bags
  ...args: any[]
) => llm.ProviderTool;

const AGENT_OUTPUT_ITEM_TYPES = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
]);

function hasToToolConfig(
  tool: llm.ProviderTool,
): tool is llm.ProviderTool & { toToolConfig: () => Record<string, unknown> } {
  return typeof (tool as { toToolConfig?: unknown }).toToolConfig === 'function';
}

export function toResponsesTool(
  tool: llm.Tool,
  strictToolSchema: boolean,
  providerToolType: ResponsesProviderToolType = OpenAITool,
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

  if (tool instanceof providerToolType && hasToToolConfig(tool)) {
    return tool.toToolConfig() as unknown as OpenAI.Responses.Tool;
  }

  return undefined;
}

export function toResponsesTools(
  toolCtx: llm.ToolContext,
  strictToolSchema: boolean,
  providerToolType: ResponsesProviderToolType = OpenAITool,
): OpenAI.Responses.Tool[] | undefined {
  // Function tools are emitted first, sorted by name for deterministic payloads; provider
  // tools follow in registration order.
  const functionTools = llm.sortedToolEntries(toolCtx).map(([, tool]) => tool);
  const providerTools = toolCtx.flatten().filter((tool) => !llm.isFunctionTool(tool));
  const tools = [...functionTools, ...providerTools]
    .map((tool) => toResponsesTool(tool, strictToolSchema, providerToolType))
    .filter((tool): tool is OpenAI.Responses.Tool => tool !== undefined);

  return tools.length > 0 ? tools : undefined;
}

/**
 * Log server-side provider tool runs from a Responses `response.completed` output list.
 *
 * Every `item.type` is a discriminator of OpenAI's `ResponseOutputItem` union.
 * Only `message`, `reasoning`, `function_call`, and `function_call_output` are
 * produced/consumed by the agent itself; everything else (web_search, xAI
 * `custom_tool_call`, …) was executed by the provider.
 */
export function logProviderToolExecutions(
  output: ReadonlyArray<{ type: string }> | undefined,
  logger: { info: (obj: unknown, msg: string) => void } = log(),
): void {
  if (!output) return;

  for (const item of output) {
    if (!AGENT_OUTPUT_ITEM_TYPES.has(item.type)) {
      logger.info(
        {
          tool_type: item.type,
          result: item,
        },
        'provider tool executed',
      );
    }
  }
}
