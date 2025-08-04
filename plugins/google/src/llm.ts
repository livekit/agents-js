// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { GoogleGenAI } from '@google/genai';
import type { APIConnectOptions } from '@livekit/agents';
import { DEFAULT_API_CONNECT_OPTIONS, llm, log } from '@livekit/agents';
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
  thinkingConfig?: { budget?: number };
  automaticFunctionCallingConfig?: boolean;
  geminiTools?: any[]; // Google-specific tools
  httpOptions?: any; // HTTP options for requests
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
  thinkingConfig?: { budget?: number };
  automaticFunctionCallingConfig?: boolean;
  geminiTools?: any[];
  httpOptions?: any;
  seed?: number;
  client: GoogleGenAI;
}

export class LLM extends llm.LLM {
  #opts: InternalLLMOptions;
  #client: GoogleGenAI;
  #logger = log();

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
   *     automaticFunctionCallingConfig (boolean, optional): The automatic function calling configuration for response generation. Defaults to None.
   *     geminiTools (array, optional): The Gemini-specific tools to use for the session.
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
    if (opts.thinkingConfig?.budget !== undefined) {
      const budget = opts.thinkingConfig.budget;
      if (!Number.isInteger(budget)) {
        throw new Error('thinking_budget inside thinkingConfig must be an integer');
      }
      if (budget < 0 || budget > 24576) {
        throw new Error('thinking_budget inside thinkingConfig must be between 0 and 24576');
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
    responseFormat?: any; // types.SchemaUnion | type[llm_utils.ResponseFormatT]
    extraKwargs?: Record<string, any>;
    geminiTools?: any[];
  }): LLMStream {
    const extra: Record<string, any> = {};

    if (extraKwargs) {
      Object.assign(extra, extraKwargs);
    }

    const finalToolChoice = toolChoice || this.#opts.toolChoice;
    if (finalToolChoice) {
      let geminiToolChoice: any;
      if (typeof finalToolChoice === 'object' && finalToolChoice.type === 'function') {
        geminiToolChoice = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [finalToolChoice.function.name],
          },
        };
        extra.toolConfig = geminiToolChoice;
      } else if (finalToolChoice === 'required') {
        const toolNames: string[] = [];
        if (toolCtx) {
          for (const [name] of Object.entries(toolCtx)) {
            toolNames.push(name);
          }
        }

        geminiToolChoice = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: toolNames.length > 0 ? toolNames : undefined,
          },
        };
        extra.toolConfig = geminiToolChoice;
      } else if (finalToolChoice === 'auto') {
        geminiToolChoice = {
          functionCallingConfig: {
            mode: 'AUTO',
          },
        };
        extra.toolConfig = geminiToolChoice;
      } else if (finalToolChoice === 'none') {
        geminiToolChoice = {
          functionCallingConfig: {
            mode: 'NONE',
          },
        };
        extra.toolConfig = geminiToolChoice;
      }
    }

    if (responseFormat) {
      // Convert response format to Google schema format
      extra.responseSchema = responseFormat;
      extra.responseMimeType = 'application/json';
    }

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

    // Add thinking config if thinking_budget is provided
    if (this.#opts.thinkingConfig !== undefined) {
      extra.thinkingConfig = this.#opts.thinkingConfig;
    }

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
  #geminiTools?: any[];
  #extraKwargs: Record<string, any>;
  #logger = log();
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
      geminiTools?: any[];
      extraKwargs: Record<string, any>;
    },
  ) {
    super(llm, chatCtx, toolCtx);
    this.#client = client;
    this.#model = model;
    this.#connOptions = connOptions;
    this.#geminiTools = geminiTools;
    this.#extraKwargs = extraKwargs;
    this.#run();
  }

  async #run(): Promise<void> {
    let retryable = true;
    const requestId = `google_${Date.now()}`;

    try {
      // Convert chat context to Google format
      const { messages, systemInstruction } = await this.#convertChatContext();

      // Convert tools if available
      const functionDeclarations = this.toolCtx ? this.#convertTools() : [];

      // Create tools config combining function tools and gemini tools
      const toolsConfig = this.#createToolsConfig(functionDeclarations, this.#geminiTools);

      // Create the request
      const request: any = {
        model: this.#model,
        contents: messages,
        ...this.#extraKwargs,
      };

      if (systemInstruction) {
        request.systemInstruction = systemInstruction;
      }

      if (toolsConfig) {
        request.tools = toolsConfig;
      }

      // Set HTTP options
      if (this.#extraKwargs.httpOptions || this.#connOptions.timeoutMs) {
        const timeout = this.#connOptions.timeoutMs
          ? Math.floor(this.#connOptions.timeoutMs)
          : undefined;
        request.generationConfig = request.generationConfig || {};
        if (timeout) {
          // Note: Google GenAI client handles timeout differently
          // This is a placeholder for proper timeout handling
        }
      }

      // Generate content stream
      const response = await this.#client.models.generateContentStream(request);

      for await (const chunk of response) {
        if (chunk.promptFeedback) {
          throw new Error(`Prompt feedback error: ${JSON.stringify(chunk.promptFeedback)}`);
        }

        if (!chunk.candidates || !chunk.candidates[0]?.content?.parts) {
          this.#logger.warn(`No candidates in the response: ${JSON.stringify(chunk)}`);
          continue;
        }

        if (chunk.candidates.length > 1) {
          this.#logger.warn(
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

  async #convertChatContext(): Promise<{ messages: any[]; systemInstruction?: any }> {
    const messages: any[] = [];
    let systemInstruction: any = undefined;
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
          messages.push({
            role: item.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: textContent }],
          });
        }
      }
    }

    if (systemMessages.length > 0) {
      systemInstruction = {
        parts: systemMessages.map((content) => ({ text: content })),
      };
    }

    return { messages, systemInstruction };
  }

  #convertTools(): any[] {
    if (!this.toolCtx) return [];

    const tools: any[] = [];

    for (const [name, tool] of Object.entries(this.toolCtx)) {
      const functionTool = tool as llm.FunctionTool<any, any, any>;
      tools.push({
        name,
        description: functionTool.description || `Function: ${name}`,
        parameters: llm.toJsonSchema(functionTool.parameters) || {
          type: 'object',
          properties: {},
          required: [],
        },
      });
    }

    return tools;
  }

  #createToolsConfig(functionTools: any[], geminiTools?: any[]): any[] | undefined {
    const tools: any[] = [];

    if (functionTools.length > 0) {
      tools.push({ functionDeclarations: functionTools });
    }

    if (geminiTools && geminiTools.length > 0) {
      tools.push(...geminiTools);
    }

    return tools.length > 0 ? tools : undefined;
  }

  #parsePart(id: string, part: any): llm.ChatChunk | null {
    if (part.functionCall) {
      return {
        id,
        delta: {
          role: 'assistant',
          toolCalls: [
            llm.FunctionCall.create({
              callId: part.functionCall.id || `function_call_${Date.now()}`,
              name: part.functionCall.name,
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
