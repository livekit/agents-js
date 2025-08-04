// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';
import { GoogleGenAI } from '@google/genai';
import type { APIConnectOptions } from '@livekit/agents';
import { DEFAULT_API_CONNECT_OPTIONS, llm } from '@livekit/agents';
import type { ChatModels } from './models.js';

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
   * Args:
   *     model (ChatModels | str, optional): The model name to use. Defaults to "gemini-2.0-flash-001".
   *     apiKey (str, optional): The API key for Google Gemini. If not provided, it attempts to read from the `GOOGLE_API_KEY` environment variable.
   *     vertexai (bool, optional): Whether to use VertexAI. If not provided, it attempts to read from the `GOOGLE_GENAI_USE_VERTEXAI` environment variable. Defaults to False.
   *         project (str, optional): The Google Cloud project to use (only for VertexAI). Defaults to None.
   *         location (str, optional): The location to use for VertexAI API requests. Defaults value is "us-central1".
   *     temperature (float, optional): Sampling temperature for response generation. Defaults to 0.8.
   *     maxOutputTokens (int, optional): Maximum number of tokens to generate in the output. Defaults to None.
   *     topP (float, optional): The nucleus sampling probability for response generation. Defaults to None.
   *     topK (int, optional): The top-k sampling value for response generation. Defaults to None.
   *     presencePenalty (float, optional): Penalizes the model for generating previously mentioned concepts. Defaults to None.
   *     frequencyPenalty (float, optional): Penalizes the model for repeating words. Defaults to None.
   *     toolChoice (ToolChoice, optional): Specifies whether to use tools during response generation. Defaults to "auto".
   *     thinkingConfig (ThinkingConfig, optional): The thinking configuration for response generation. Defaults to None.
   *     automaticFunctionCallingConfig (AutomaticFunctionCallingConfig, optional): The automatic function calling configuration for response generation. Defaults to None.
   *     geminiTools (Tool[], optional): The Gemini-specific tools to use for the session.
   *     httpOptions (HttpOptions, optional): The HTTP options to use for the session.
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
    parallelToolCalls,
    toolChoice,
    responseFormat,
    extraKwargs,
    geminiTools,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    responseFormat?: types.Schema;
    extraKwargs?: Record<string, any>;
    geminiTools?: types.Tool[];
  }): LLMStream {
    const config: Partial<types.GenerateContentConfig> = {};

    if (extraKwargs) {
      Object.assign(config, extraKwargs);
    }

    const finalToolChoice = toolChoice || this.#opts.toolChoice;
    if (finalToolChoice) {
      let geminiToolConfig: types.ToolConfig;
      if (typeof finalToolChoice === 'object' && finalToolChoice.type === 'function') {
        geminiToolConfig = {
          functionCallingConfig: {
            mode: 'ANY' as any,
            allowedFunctionNames: [finalToolChoice.function.name],
          },
        };
        config.toolConfig = geminiToolConfig;
      } else if (finalToolChoice === 'required') {
        const toolNames: string[] = [];
        if (toolCtx) {
          for (const [name] of Object.entries(toolCtx)) {
            toolNames.push(name);
          }
        }

        geminiToolConfig = {
          functionCallingConfig: {
            mode: 'ANY' as any,
            allowedFunctionNames: toolNames.length > 0 ? toolNames : undefined,
          },
        };
        config.toolConfig = geminiToolConfig;
      } else if (finalToolChoice === 'auto') {
        geminiToolConfig = {
          functionCallingConfig: {
            mode: 'AUTO' as any,
          },
        };
        config.toolConfig = geminiToolConfig;
      } else if (finalToolChoice === 'none') {
        geminiToolConfig = {
          functionCallingConfig: {
            mode: 'NONE' as any,
          },
        };
        config.toolConfig = geminiToolConfig;
      }
    }

    if (responseFormat) {
      config.responseSchema = responseFormat;
      config.responseMimeType = 'application/json';
    }

    if (this.#opts.temperature !== undefined) {
      config.temperature = this.#opts.temperature;
    }
    if (this.#opts.maxOutputTokens !== undefined) {
      config.maxOutputTokens = this.#opts.maxOutputTokens;
    }
    if (this.#opts.topP !== undefined) {
      config.topP = this.#opts.topP;
    }
    if (this.#opts.topK !== undefined) {
      config.topK = this.#opts.topK;
    }
    if (this.#opts.presencePenalty !== undefined) {
      config.presencePenalty = this.#opts.presencePenalty;
    }
    if (this.#opts.frequencyPenalty !== undefined) {
      config.frequencyPenalty = this.#opts.frequencyPenalty;
    }
    if (this.#opts.seed !== undefined) {
      config.seed = this.#opts.seed;
    }

    // Add thinking config if provided
    if (this.#opts.thinkingConfig !== undefined) {
      config.thinkingConfig = this.#opts.thinkingConfig;
    }

    if (this.#opts.automaticFunctionCallingConfig !== undefined) {
      config.automaticFunctionCalling = this.#opts.automaticFunctionCallingConfig;
    }

    if (this.#opts.httpOptions !== undefined) {
      config.httpOptions = this.#opts.httpOptions;
    }

    const finalGeminiTools = geminiTools || this.#opts.geminiTools;

    return new LLMStream(this, {
      client: this.#client,
      model: this.#opts.model,
      chatCtx,
      toolCtx,
      connOptions,
      geminiTools: finalGeminiTools,
      config,
    });
  }
}

export class LLMStream extends llm.LLMStream {
  #client: GoogleGenAI;
  #model: string;
  #connOptions: APIConnectOptions;
  #geminiTools?: types.Tool[];
  #config: Partial<types.GenerateContentConfig>;
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
      config,
    }: {
      client: GoogleGenAI;
      model: string;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      geminiTools?: types.Tool[];
      config: Partial<types.GenerateContentConfig>;
    },
  ) {
    super(llm, chatCtx, toolCtx);
    this.#client = client;
    this.#model = model;
    this.#connOptions = connOptions;
    this.#geminiTools = geminiTools;
    this.#config = config;
    this.#run();
  }

  async #run(): Promise<void> {
    let retryable = true;
    const requestId = `google_${Date.now()}`;

    try {
      // Convert chat context to Google format
      const { contents, systemInstruction } = await this.#convertChatContext();

      // Convert tools if available
      const functionDeclarations = this.toolCtx ? this.#convertTools() : [];

      // Create tools config combining function tools and gemini tools
      const tools = this.#createTools(functionDeclarations, this.#geminiTools);

      // Create the request parameters
      const parameters: types.GenerateContentParameters = {
        model: this.#model,
        contents,
        config: {
          ...this.#config,
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
            ...this.#config.httpOptions,
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
            retryable = false;
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
    } catch (error: any) {
      // Handle different types of Google API errors
      if (error.code === 429) {
        throw new Error(`Google LLM: Rate limit error - ${error.message}`);
      } else if (error.code >= 500) {
        throw new Error(`Google LLM: Server error - ${error.message}`);
      } else {
        throw new Error(`Google LLM: API error - ${error.message}`);
      }
    } finally {
      this.queue.close();
    }
  }

  async #convertChatContext(): Promise<{
    contents: types.Content[];
    systemInstruction?: types.Content;
  }> {
    const contents: types.Content[] = [];
    let systemInstruction: types.Content | undefined = undefined;
    const systemMessages: string[] = [];

    for (const item of this.chatCtx.items) {
      if (item instanceof llm.ChatMessage) {
        // Extract text content - handle both string and array cases
        let textContent = '';
        if (typeof item.content === 'string') {
          textContent = item.content;
        } else if (Array.isArray(item.content)) {
          // Extract text from content array, focusing on text content
          textContent = item.content
            .map((c: any) => {
              if (typeof c === 'string') return c;
              if (c && typeof c === 'object' && 'text' in c) return c.text;
              return '';
            })
            .join('');
        } else if (
          item.content &&
          typeof item.content === 'object' &&
          'text' in (item.content as any)
        ) {
          textContent = (item.content as any).text;
        }

        if (item.role === 'system') {
          systemMessages.push(textContent);
        } else {
          const parts: types.Part[] = [{ text: textContent }];
          contents.push({
            role: item.role === 'assistant' ? 'model' : 'user',
            parts,
          });
        }
      }
    }

    if (systemMessages.length > 0) {
      const systemParts: types.Part[] = systemMessages.map((content) => ({ text: content }));
      systemInstruction = {
        parts: systemParts,
      };
    }

    return { contents, systemInstruction };
  }

  #convertTools(): types.FunctionDeclaration[] {
    if (!this.toolCtx) return [];

    const functionDeclarations: types.FunctionDeclaration[] = [];

    for (const [name, tool] of Object.entries(this.toolCtx)) {
      const functionTool = tool as llm.FunctionTool<any, any, any>;
      functionDeclarations.push({
        name,
        description: functionTool.description || `Function: ${name}`,
        parameters: (llm.toJsonSchema(functionTool.parameters) as any) || {
          type: 'object',
          properties: {},
          required: [],
        },
      });
    }

    return functionDeclarations;
  }

  #createTools(
    functionDeclarations: types.FunctionDeclaration[],
    geminiTools?: types.Tool[],
  ): types.Tool[] | undefined {
    const tools: types.Tool[] = [];

    if (functionDeclarations.length > 0) {
      tools.push({ functionDeclarations });
    }

    if (geminiTools && geminiTools.length > 0) {
      tools.push(...geminiTools);
    }

    return tools.length > 0 ? tools : undefined;
  }

  #parsePart(id: string, part: types.Part): llm.ChatChunk | null {
    if (part.functionCall) {
      return {
        id,
        delta: {
          role: 'assistant',
          toolCalls: [
            llm.FunctionCall.create({
              callId: part.functionCall.name || `function_call_${Date.now()}`,
              name: part.functionCall.name || 'unknown_function',
              args: JSON.stringify(part.functionCall.args || {}),
            }),
          ],
          content: part.text,
        },
      };
    }

    return {
      id,
      delta: {
        content: part.text,
        role: 'assistant',
      },
    };
  }
}
