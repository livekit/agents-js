// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, log } from '@livekit/agents';
import {
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
  type UserModelMessage,
  streamText,
} from 'ai';

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
    const tools = this.toolCtx
      ? Object.fromEntries(
          Object.entries(this.toolCtx).map(([name, func]) => [
            name,
            {
              description: func.description,
              parameters: func.parameters,
            },
          ]),
        )
      : undefined;

    try {
      // Convert messages to AI SDK format
      const messages: ModelMessage[] = this.chatCtx.items.map((item) => {
        if (item.type === 'message') {
          return {
            role: item.role,
            content: Array.isArray(item.content)
              ? item.content.map((c) =>
                  typeof c === 'string'
                    ? { type: 'text' as const, text: c }
                    : c.type === 'image_content'
                      ? { type: 'image' as const, image: c.image }
                      : { type: 'text' as const, text: String(c) },
                )
              : item.content,
          } as ModelMessage;
        } else if (item.type === 'function_call') {
          return {
            role: 'assistant',
            content: '',
            toolInvocations: [
              {
                toolCallId: item.callId,
                toolName: item.name,
                args: JSON.parse(item.args),
              },
            ],
          } as ModelMessage;
        } else if (item.type === 'function_call_output') {
          return {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: item.callId,
                toolName: item.name,
                output: {
                  type: 'text',
                  value: item.output,
                },
              },
            ],
          } as ModelMessage;
        }

        // Fallback
        return {
          role: 'user',
          content: 'Invalid message type',
        } as UserModelMessage;
      });

      const result = streamText({
        model: opts.model,
        prompt: opts.prompt,
        messages,
        tools,
        toolChoice,
        temperature,
      });

      for await (const part of result.fullStream) {
        if (this.abortController.signal.aborted) {
          break;
        }
        switch (part.type) {
          case 'start': {
            // handle start of stream
            break;
          }
          case 'start-step': {
            // handle start of step
            break;
          }
          case 'text-start': {
            // handle text start
            break;
          }
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
          case 'text-end': {
            // handle text end
            break;
          }
          case 'reasoning-start': {
            // handle reasoning start
            break;
          }
          case 'reasoning-delta': {
            // handle reasoning delta here
            break;
          }
          case 'reasoning-end': {
            // handle reasoning end
            break;
          }
          case 'source': {
            // handle source here
            break;
          }
          case 'file': {
            // handle file here
            break;
          }
          case 'tool-call': {
            switch (part.toolName) {
              case 'cityAttractions': {
                // handle tool call here
                break;
              }
            }
            break;
          }
          case 'tool-input-start': {
            // handle tool input start
            break;
          }
          case 'tool-input-delta': {
            // handle tool input delta
            break;
          }
          case 'tool-input-end': {
            // handle tool input end
            break;
          }
          case 'tool-result': {
            switch (part.toolName) {
              case 'cityAttractions': {
                // handle tool result here
                break;
              }
            }
            break;
          }
          case 'tool-error': {
            // handle tool error
            break;
          }
          case 'finish-step': {
            // handle finish step
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
            break;
          }
          case 'raw': {
            // handle raw value
            break;
          }
        }
      }
    } finally {
      this.queue.close();
    }
  }
}
