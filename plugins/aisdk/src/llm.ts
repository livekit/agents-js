// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, log } from '@livekit/agents';
import { type ModelMessage, type ToolChoice, type ToolSet, streamText } from 'ai';

export class LLM extends llm.LLM {
  #opts: Parameters<typeof streamText>[0];

  constructor(...params: Parameters<typeof streamText>) {
    super();
    this.#opts = params[0];
  }

  chat({
    chatCtx,
    toolCtx,
    toolChoice,
    temperature,
    n,
    parallelToolCalls,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext | undefined;
    toolChoice?: llm.ToolChoice;
    temperature?: number | undefined;
    n?: number | undefined;
    parallelToolCalls?: boolean | undefined;
  }): LLMStream {
    temperature = temperature || this.#opts.temperature;
    const convertedToolChoice = toolChoice
      ? this.toLLMToolChoice(toolChoice)
      : this.#opts.toolChoice;

    return new LLMStream(
      this,
      chatCtx,
      toolCtx,
      this.#opts,
      parallelToolCalls,
      temperature,
      n,
      convertedToolChoice,
    );
  }

  private toLLMToolChoice(toolChoice: llm.ToolChoice): ToolChoice<ToolSet> | undefined {
    if (typeof toolChoice === 'string') {
      // Direct mapping for string literals
      switch (toolChoice) {
        case 'auto':
        case 'none':
        case 'required':
          return toolChoice;
        default:
          return 'auto'; // fallback
      }
    }

    if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      // Convert agents framework function choice to AI SDK tool choice
      return {
        type: 'tool',
        toolName: toolChoice.function.name,
      };
    }

    return 'auto'; // fallback
  }
}

export class LLMStream extends llm.LLMStream {
  // Current function call that we're waiting for full completion (args are streamed)
  #toolCallId?: string;
  #fncName?: string;
  #fncRawArguments?: string;
  #toolIndex?: number;
  #logger = log();
  label = 'openai.LLMStream';

  constructor(
    llm: LLM,
    chatCtx: llm.ChatContext,
    toolCtx: llm.ToolContext | undefined,
    opts: Parameters<typeof streamText>[0],
    parallelToolCalls?: boolean,
    temperature?: number,
    n?: number,
    toolChoice?: ToolChoice<ToolSet>,
  ) {
    super(llm, chatCtx, toolCtx);
    this.#run(opts, n, parallelToolCalls, temperature, toolChoice);
  }

  async #run(
    opts: Parameters<typeof streamText>[0],
    n?: number,
    parallelToolCalls?: boolean,
    temperature?: number,
    toolChoice?: ToolChoice<ToolSet>,
  ) {
    // Convert tools to AI SDK format

    try {
      // Convert messages to AI SDK format
      // @ts-ignore
      const messages: ModelMessage[] = this.chatCtx.items
        .map((item) => {
          if (item.type === 'message') {
            return {
              role: item.role === 'developer' ? 'user' : item.role,
              content: Array.isArray(item.content)
                ? item.content.map((c) => (typeof c === 'string' ? c : '')).join('\n')
                : item.content,
            } satisfies ModelMessage;
          } else if (item.type === 'function_call') {
            return {
              role: 'assistant',
              content: '',
            } satisfies ModelMessage;
          } else if (item.type === 'function_call_output') {
            return undefined;
          }
        })
        .filter((m) => m !== undefined);

      console.log('calling stream text', messages);

      const result = streamText({
        model: opts.model,
        messages,
        tools: opts.tools,
        toolChoice,
        temperature,
      });

      for await (const part of result.fullStream) {
        if (this.abortController.signal.aborted) {
          break;
        }
        console.log('received part', part.type);
        switch (part.type) {
          case 'text-delta': {
            // handle text delta here
            this.queue.put({
              id: part.id,
              delta: {
                role: 'assistant',
                content: part.text,
              },
            });
            break;
          }

          case 'tool-call': {
            // handle tool call here
            this.queue.put({
              id: part.toolCallId,
              delta: {
                role: 'assistant',
                content: `_Calling tool ${part.toolName} with input ${JSON.stringify(part.input)}_\n`,
              },
            });
            break;
          }

          case 'tool-result': {
            // handle tool result here
            this.queue.put({
              id: part.toolCallId,
              delta: {
                role: 'assistant',
                content: part.output,
              },
            });
            break;
          }

          case 'finish': {
            // handle finish here
            this.queue.put({
              id: 'finish',
              usage: {
                completionTokens: part.totalUsage.outputTokens || 0,
                promptTokens: part.totalUsage.inputTokens || 0,
                totalTokens: part.totalUsage.totalTokens || 0,
                promptCachedTokens: part.totalUsage.cachedInputTokens || 0,
              },
            });
            break;
          }
          case 'error': {
            // handle error here
            console.error('error', part.error);
            break;
          }
        }
      }
    } finally {
      this.queue.close();
    }
  }
}
