// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';
import { GoogleGenAI } from '@google/genai';
import type { APIConnectOptions } from '@livekit/agents';
import { DEFAULT_API_CONNECT_OPTIONS, llm } from '@livekit/agents';
import type { ChatModels } from './models.js';

interface GoogleFormatData {
  systemMessages: string[] | null;
}

export interface LLMOptions {
  model?: string | ChatModels;
  apiKey?: string;
  vertexai?: boolean;
  project?: string;
  location?: string;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  toolChoice?: llm.ToolChoice;
  thinkingConfig?: types.ThinkingConfig;
  automaticFunctionCallingConfig?: types.AutomaticFunctionCallingConfig;
  geminiTools?: types.Tool[];
  httpOptions?: types.HttpOptions;
  seed?: number;
  client?: GoogleGenAI;
}

interface InternalLLMOptions {
  model: string;
  apiKey?: string;
  vertexai: boolean;
  project?: string;
  location: string;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  toolChoice?: llm.ToolChoice;
  thinkingConfig?: types.ThinkingConfig;
  automaticFunctionCallingConfig?: types.AutomaticFunctionCallingConfig;
  geminiTools?: types.Tool[];
  httpOptions?: types.HttpOptions;
  seed?: number;
  client: GoogleGenAI;
}

export class LLM extends llm.LLM {
  #opts: InternalLLMOptions;
  #client: GoogleGenAI;

  get model(): string {
    return this.#opts.model;
  }

  /**
   * Create a new instance of Google GenAI LLM.
   *
   * Environment Requirements:
   * - For VertexAI: Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the path of the service account key file or use any of the other Google Cloud auth methods.
   * The Google Cloud project and location can be set via `project` and `location` arguments or the environment variables
   * `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`. By default, the project is inferred from the service account key file,
   * and the location defaults to "us-central1".
   * - For Google Gemini API: Set the `apiKey` argument or the `GOOGLE_API_KEY` environment variable.
   *
   * @param model - The model name to use. Defaults to "gemini-2.0-flash-001".
   * @param apiKey - The API key for Google Gemini. If not provided, it attempts to read from the `GOOGLE_API_KEY` environment variable.
   * @param vertexai - Whether to use VertexAI. If not provided, it attempts to read from the `GOOGLE_GENAI_USE_VERTEXAI` environment variable. Defaults to false.
   * @param project - The Google Cloud project to use (only for VertexAI). Defaults to undefined.
   * @param location - The location to use for VertexAI API requests. Default value is "us-central1".
   * @param temperature - Sampling temperature for response generation. Defaults to undefined.
   * @param maxOutputTokens - Maximum number of tokens to generate in the output. Defaults to undefined.
   * @param topP - The nucleus sampling probability for response generation. Defaults to undefined.
   * @param topK - The top-k sampling value for response generation. Defaults to undefined.
   * @param presencePenalty - Penalizes the model for generating previously mentioned concepts. Defaults to undefined.
   * @param frequencyPenalty - Penalizes the model for repeating words. Defaults to undefined.
   * @param toolChoice - Specifies whether to use tools during response generation. Defaults to "auto".
   * @param thinkingConfig - The thinking configuration for response generation. Defaults to undefined.
   * @param automaticFunctionCallingConfig - The automatic function calling configuration for response generation. Defaults to undefined.
   * @param geminiTools - The Gemini-specific tools to use for the session.
   * @param httpOptions - The HTTP options to use for the session.
   * @param seed - Random seed for reproducible results. Defaults to undefined.
   */
  constructor(opts: LLMOptions = {}) {
    super();

    // Set up authentication and client configuration
    const apiKey = opts.apiKey || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
    const useVertexAI =
      opts.vertexai ??
      (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' ||
        process.env.GOOGLE_GENAI_USE_VERTEXAI === '1');

    let client: GoogleGenAI;

    if (opts.client) {
      client = opts.client;
    } else if (useVertexAI) {
      // Vertex AI configuration
      const project = opts.project || process.env.GOOGLE_CLOUD_PROJECT;
      const location = opts.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

      if (!project) {
        throw new Error(
          'Project ID is required for Vertex AI. Set via project option or GOOGLE_CLOUD_PROJECT environment variable',
        );
      }

      client = new GoogleGenAI({
        vertexai: true,
        project,
        location,
      });
    } else {
      // Google AI Studio configuration
      if (!apiKey) {
        throw new Error(
          'API key is required for Google AI Studio. Set via apiKey option or GOOGLE_API_KEY environment variable',
        );
      }

      client = new GoogleGenAI({
        apiKey,
      });
    }

    // Validate thinking_config
    if (opts.thinkingConfig?.thinkingBudget !== undefined) {
      const budget = opts.thinkingConfig.thinkingBudget;
      if (!Number.isInteger(budget)) {
        throw new Error('thinkingBudget inside thinkingConfig must be an integer');
      }
      if (budget < 0 || budget > 24576) {
        throw new Error('thinkingBudget inside thinkingConfig must be between 0 and 24576');
      }
    }

    this.#client = client;
    this.#opts = {
      model: opts.model || 'gemini-2.0-flash-001',
      apiKey,
      vertexai: useVertexAI,
      project: opts.project,
      location: opts.location || 'us-central1',
      temperature: opts.temperature,
      maxOutputTokens: opts.maxOutputTokens,
      topP: opts.topP,
      topK: opts.topK,
      presencePenalty: opts.presencePenalty,
      frequencyPenalty: opts.frequencyPenalty,
      toolChoice: opts.toolChoice,
      thinkingConfig: opts.thinkingConfig,
      automaticFunctionCallingConfig: opts.automaticFunctionCallingConfig,
      geminiTools: opts.geminiTools,
      httpOptions: opts.httpOptions,
      seed: opts.seed,
      client: this.#client,
    };
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    _parallelToolCalls,
    toolChoice,
    responseFormat,
    extraKwargs,
    geminiTools,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    _parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    responseFormat?: types.Schema;
    extraKwargs?: Record<string, unknown>;
    geminiTools?: types.Tool[];
  }): LLMStream {
    const extra: Record<string, unknown> = {};

    if (extraKwargs) {
      Object.assign(extra, extraKwargs);
    }

    // Handle tool choice - matches Python's tool_choice processing
    const finalToolChoice = toolChoice || this.#opts.toolChoice;
    if (finalToolChoice) {
      let geminiToolConfig: types.ToolConfig;
      if (typeof finalToolChoice === 'object' && finalToolChoice.type === 'function') {
        geminiToolConfig = {
          functionCallingConfig: {
            mode: 'ANY' as types.FunctionCallingConfig['mode'],
            allowedFunctionNames: [finalToolChoice.function.name],
          },
        };
        extra.toolConfig = geminiToolConfig;
      } else if (finalToolChoice === 'required') {
        const toolNames: string[] = [];
        if (toolCtx) {
          for (const [name] of Object.entries(toolCtx)) {
            toolNames.push(name);
          }
        }

        geminiToolConfig = {
          functionCallingConfig: {
            mode: 'ANY' as types.FunctionCallingConfig['mode'],
            allowedFunctionNames: toolNames.length > 0 ? toolNames : undefined,
          },
        };
        extra.toolConfig = geminiToolConfig;
      } else if (finalToolChoice === 'auto') {
        geminiToolConfig = {
          functionCallingConfig: {
            mode: 'AUTO' as types.FunctionCallingConfig['mode'],
          },
        };
        extra.toolConfig = geminiToolConfig;
      } else if (finalToolChoice === 'none') {
        geminiToolConfig = {
          functionCallingConfig: {
            mode: 'NONE' as types.FunctionCallingConfig['mode'],
          },
        };
        extra.toolConfig = geminiToolConfig;
      }
    }

    // Handle response format - matches Python's response_format processing
    if (responseFormat) {
      extra.responseSchema = responseFormat;
      extra.responseMimeType = 'application/json';
    }

    // Add individual option checks to match Python's structure
    if (this.#opts.temperature !== undefined) {
      extra.temperature = this.#opts.temperature;
    }
    if (this.#opts.maxOutputTokens !== undefined) {
      extra.maxOutputTokens = this.#opts.maxOutputTokens;
    }
    if (this.#opts.topP !== undefined) {
      extra.topP = this.#opts.topP;
    }
    if (this.#opts.topK !== undefined) {
      extra.topK = this.#opts.topK;
    }
    if (this.#opts.presencePenalty !== undefined) {
      extra.presencePenalty = this.#opts.presencePenalty;
    }
    if (this.#opts.frequencyPenalty !== undefined) {
      extra.frequencyPenalty = this.#opts.frequencyPenalty;
    }
    if (this.#opts.seed !== undefined) {
      extra.seed = this.#opts.seed;
    }

    // Add thinking config if provided - matches Python's thinking_config handling
    if (this.#opts.thinkingConfig !== undefined) {
      extra.thinkingConfig = this.#opts.thinkingConfig;
    }

    // Add automatic function calling config - matches Python's automatic_function_calling_config
    if (this.#opts.automaticFunctionCallingConfig !== undefined) {
      extra.automaticFunctionCalling = this.#opts.automaticFunctionCallingConfig;
    }

    const finalGeminiTools = geminiTools || this.#opts.geminiTools;

    return new LLMStream(this, {
      client: this.#client,
      model: this.#opts.model,
      chatCtx,
      toolCtx,
      connOptions,
      geminiTools: finalGeminiTools,
      extraKwargs: extra,
    });
  }
}

export class LLMStream extends llm.LLMStream {
  #client: GoogleGenAI;
  #model: string;
  #connOptions: APIConnectOptions;
  #geminiTools?: types.Tool[];
  #extraKwargs: Record<string, unknown>;
  label = 'google.LLMStream';

  constructor(
    llm: LLM,
    {
      client,
      model,
      chatCtx,
      toolCtx,
      connOptions,
      geminiTools,
      extraKwargs,
    }: {
      client: GoogleGenAI;
      model: string;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      geminiTools?: types.Tool[];
      extraKwargs: Record<string, unknown>;
    },
  ) {
    // Call base constructor - matches Python's LLMStream initialization pattern
    super(llm, chatCtx, toolCtx);
    this.#client = client;
    this.#model = model;
    this.#connOptions = connOptions;
    this.#geminiTools = geminiTools;
    this.#extraKwargs = extraKwargs;
    this.#run();
  }

  async #run(): Promise<void> {
    let _retryable = true;
    const requestId = `google_${Date.now()}`;

    try {
      // Convert chat context using native Google provider format
      const [turns, extraData] = (await this.chatCtx.toProviderFormat('google')) as [
        Record<string, unknown>[],
        GoogleFormatData,
      ];

      // Convert to Google GenAI format
      const contents: types.Content[] = turns.map((turn: Record<string, unknown>) => ({
        role: turn.role as types.Content['role'],
        parts: turn.parts as types.Part[],
      }));

      // Convert tools from ToolContext if available
      const tools = this.toolCtx ? this.#convertTools() : undefined;

      // Create system instruction from extra data
      let systemInstruction: types.Content | undefined = undefined;
      if (extraData.systemMessages && extraData.systemMessages.length > 0) {
        systemInstruction = {
          parts: extraData.systemMessages.map((content: string) => ({ text: content })),
        };
      }

      // Create the request parameters
      const parameters: types.GenerateContentParameters = {
        model: this.#model,
        contents,
        config: {
          ...this.#extraKwargs,
          systemInstruction,
          tools,
        },
      };

      // Set HTTP options with timeout
      if (this.#connOptions.timeoutMs) {
        const timeout = Math.floor(this.#connOptions.timeoutMs);
        parameters.config = {
          ...parameters.config,
          httpOptions: {
            ...(this.#extraKwargs.httpOptions as Record<string, unknown>),
            timeout,
          },
        };
      }

      // Generate content stream
      const response = await this.#client.models.generateContentStream(parameters);

      for await (const chunk of response) {
        if (chunk.promptFeedback) {
          throw new Error(`Prompt feedback error: ${JSON.stringify(chunk.promptFeedback)}`);
        }

        if (!chunk.candidates || !chunk.candidates[0]?.content?.parts) {
          this.logger.warn(`No candidates in the response: ${JSON.stringify(chunk)}`);
          continue;
        }

        if (chunk.candidates.length > 1) {
          this.logger.warn(
            'Google LLM: there are multiple candidates in the response, returning response from the first one.',
          );
        }

        for (const part of chunk.candidates[0].content.parts) {
          const chatChunk = this.#parsePart(requestId, part);
          if (chatChunk) {
            _retryable = false;
            this.queue.put(chatChunk);
          }
        }

        if (chunk.usageMetadata) {
          const usage = chunk.usageMetadata;
          this.queue.put({
            id: requestId,
            usage: {
              completionTokens: usage.candidatesTokenCount || 0,
              promptTokens: usage.promptTokenCount || 0,
              promptCachedTokens: usage.cachedContentTokenCount || 0,
              totalTokens: usage.totalTokenCount || 0,
            },
          });
        }
      }
    } catch (error: unknown) {
      // Handle different types of Google API errors - matches Python's error handling structure
      const err = error as {
        code?: number;
        message?: string;
        status?: string;
        type?: string;
      };

      // Match Python's ClientError handling (status codes 400-499)
      if (err.code && err.code >= 400 && err.code < 500) {
        if (err.code === 429) {
          throw new Error(`Google LLM: Rate limit error - ${err.message || 'Unknown error'}`);
        } else {
          throw new Error(
            `Google LLM: Client error (${err.code}) - ${err.message || 'Unknown error'}`,
          );
        }
      }

      // Match Python's ServerError handling (status codes 500+)
      if (err.code && err.code >= 500) {
        throw new Error(
          `Google LLM: Server error (${err.code}) - ${err.message || 'Unknown error'}`,
        );
      }

      // Match Python's generic APIError handling
      throw new Error(`Google LLM: API error - ${err.message || 'Unknown error'}`);
    } finally {
      this.queue.close();
    }
  }

  #convertTools(): types.Tool[] | undefined {
    if (!this.toolCtx) return undefined;

    const functionDeclarations: types.FunctionDeclaration[] = [];

    for (const [name, tool] of Object.entries(this.toolCtx)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const functionTool = tool as llm.FunctionTool<any, any, any>;
      functionDeclarations.push({
        name,
        description: functionTool.description || `Function: ${name}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters: (llm.toJsonSchema(functionTool.parameters) as any) || {
          type: 'object',
          properties: {},
          required: [],
        },
      });
    }

    return functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined;
  }

  #parsePart(id: string, part: types.Part): llm.ChatChunk | null {
    // Handle function calls
    if (part.functionCall) {
      return {
        id,
        delta: {
          role: 'assistant',
          toolCalls: [
            llm.FunctionCall.create({
              callId: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              name: part.functionCall.name || 'unknown_function',
              args: JSON.stringify(part.functionCall.args || {}),
            }),
          ],
        },
      };
    }

    // Handle text content
    if (part.text) {
      return {
        id,
        delta: {
          content: part.text,
          role: 'assistant',
        },
      };
    }

    return null;
  }
}
