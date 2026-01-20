// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';
import { FunctionCallingConfigMode, type GenerateContentConfig, GoogleGenAI } from '@google/genai';
import type { APIConnectOptions } from '@livekit/agents';
import {
  APIConnectionError,
  APIStatusError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  shortuuid,
} from '@livekit/agents';
import type { ChatModels } from './models.js';
import type { LLMTools } from './tools.js';
import { toFunctionDeclarations } from './utils.js';

interface GoogleFormatData {
  systemMessages: string[] | null;
}

export interface LLMOptions {
  model: string | ChatModels;
  apiKey?: string;
  temperature?: number;
  toolChoice?: llm.ToolChoice;
  vertexai?: boolean;
  project?: string;
  location?: string;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  thinkingConfig?: types.ThinkingConfig;
  automaticFunctionCallingConfig?: types.AutomaticFunctionCallingConfig;
  geminiTools?: LLMTools;
  httpOptions?: types.HttpOptions;
  seed?: number;
}

export class LLM extends llm.LLM {
  #opts: LLMOptions;
  #client: GoogleGenAI;

  label(): string {
    return 'google.LLM';
  }

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
  constructor(
    {
      model,
      apiKey,
      vertexai,
      project,
      location,
      temperature,
      maxOutputTokens,
      topP,
      topK,
      presencePenalty,
      frequencyPenalty,
      toolChoice,
      thinkingConfig,
      automaticFunctionCallingConfig,
      geminiTools,
      httpOptions,
      seed,
    }: LLMOptions = {
      model: 'gemini-2.0-flash-001',
    },
  ) {
    super();

    const useVertexAI =
      vertexai ??
      (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' ||
        process.env.GOOGLE_GENAI_USE_VERTEXAI === '1');

    let gcpProject: string | undefined = project ?? process.env.GOOGLE_CLOUD_PROJECT;
    let gcpLocation: string | undefined = location ?? process.env.GOOGLE_CLOUD_LOCATION;
    let geminiApiKey: string | undefined = apiKey ?? process.env.GOOGLE_API_KEY;

    if (useVertexAI) {
      if (!gcpProject) {
        // TODO(brian): use default_async to get the project ID
        throw new Error(
          'Project ID is required for Vertex AI. Set via project option or GOOGLE_CLOUD_PROJECT environment variable',
        );
      }
      geminiApiKey = undefined;
    } else {
      gcpProject = undefined;
      gcpLocation = undefined;
      if (!geminiApiKey) {
        throw new Error(
          'API key is required for Google API either via apiKey or GOOGLE_API_KEY environment variable',
        );
      }
    }

    // Validate thinkingConfig
    if (thinkingConfig?.thinkingBudget !== undefined) {
      const budget = thinkingConfig.thinkingBudget;
      if (budget < 0 || budget > 24576) {
        throw new Error('thinkingBudget inside thinkingConfig must be between 0 and 24576');
      }
    }

    const clientOptions: types.GoogleGenAIOptions = useVertexAI
      ? {
          vertexai: true,
          project: gcpProject,
          location: gcpLocation,
        }
      : {
          apiKey: geminiApiKey,
        };

    this.#client = new GoogleGenAI(clientOptions);

    this.#opts = {
      model,
      vertexai: useVertexAI,
      project: gcpProject,
      location: gcpLocation,
      temperature,
      maxOutputTokens,
      topP,
      topK,
      presencePenalty,
      frequencyPenalty,
      toolChoice,
      thinkingConfig,
      automaticFunctionCallingConfig,
      geminiTools,
      httpOptions,
      seed,
      apiKey,
    };
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    toolChoice,
    extraKwargs,
    geminiTools,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
    geminiTools?: LLMTools;
  }): LLMStream {
    const extras: GenerateContentConfig = { ...extraKwargs } as GenerateContentConfig;

    toolChoice = toolChoice !== undefined ? toolChoice : this.#opts.toolChoice;

    if (toolChoice) {
      let geminiToolConfig: types.ToolConfig;

      if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
        geminiToolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: [toolChoice.function.name],
          },
        };
      } else if (toolChoice === 'required') {
        const toolNames = Object.entries(toolCtx || {}).map(([name]) => name);
        geminiToolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: toolNames.length > 0 ? toolNames : undefined,
          },
        };
      } else if (toolChoice === 'auto') {
        geminiToolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.AUTO,
          },
        };
      } else if (toolChoice === 'none') {
        geminiToolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.NONE,
          },
        };
      } else {
        throw new Error(`Invalid tool choice: ${toolChoice}`);
      }

      extras.toolConfig = geminiToolConfig;
    }

    if (this.#opts.temperature !== undefined) {
      extras.temperature = this.#opts.temperature;
    }
    if (this.#opts.maxOutputTokens !== undefined) {
      extras.maxOutputTokens = this.#opts.maxOutputTokens;
    }
    if (this.#opts.topP !== undefined) {
      extras.topP = this.#opts.topP;
    }
    if (this.#opts.topK !== undefined) {
      extras.topK = this.#opts.topK;
    }
    if (this.#opts.presencePenalty !== undefined) {
      extras.presencePenalty = this.#opts.presencePenalty;
    }
    if (this.#opts.frequencyPenalty !== undefined) {
      extras.frequencyPenalty = this.#opts.frequencyPenalty;
    }
    if (this.#opts.seed !== undefined) {
      extras.seed = this.#opts.seed;
    }

    if (this.#opts.thinkingConfig !== undefined) {
      extras.thinkingConfig = this.#opts.thinkingConfig;
    }

    if (this.#opts.automaticFunctionCallingConfig !== undefined) {
      extras.automaticFunctionCalling = this.#opts.automaticFunctionCallingConfig;
    }

    geminiTools = geminiTools !== undefined ? geminiTools : this.#opts.geminiTools;

    return new LLMStream(this, {
      client: this.#client,
      model: this.#opts.model,
      chatCtx,
      toolCtx,
      connOptions,
      geminiTools,
      extraKwargs: extras,
    });
  }
}

export class LLMStream extends llm.LLMStream {
  #client: GoogleGenAI;
  #model: string;
  #geminiTools?: LLMTools;
  #extraKwargs: GenerateContentConfig;

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
      geminiTools?: LLMTools;
      extraKwargs: GenerateContentConfig;
    },
  ) {
    // Call base constructor with dev 1.0 object parameter pattern
    super(llm, { chatCtx, toolCtx, connOptions });
    this.#client = client;
    this.#model = model;
    this.#geminiTools = geminiTools;
    this.#extraKwargs = extraKwargs;
  }

  protected async run(): Promise<void> {
    let retryable = true;
    const requestId = `google_${Date.now()}`;

    try {
      const [turns, extraData] = (await this.chatCtx.toProviderFormat('google')) as [
        Record<string, unknown>[],
        GoogleFormatData,
      ];

      const contents: types.Content[] = turns.map((turn: Record<string, unknown>) => ({
        role: turn.role as types.Content['role'],
        parts: turn.parts as types.Part[],
      }));

      const functionDeclarations = this.toolCtx ? toFunctionDeclarations(this.toolCtx) : undefined;
      const tools =
        functionDeclarations && functionDeclarations.length > 0
          ? [{ functionDeclarations }]
          : undefined;

      let systemInstruction: types.Content | undefined = undefined;
      if (extraData.systemMessages && extraData.systemMessages.length > 0) {
        systemInstruction = {
          parts: extraData.systemMessages.map((content: string) => ({ text: content })),
        };
      }

      const response = await this.#client.models.generateContentStream({
        model: this.#model,
        contents,
        config: {
          ...this.#extraKwargs,
          systemInstruction,
          httpOptions: this.#extraKwargs.httpOptions ?? {
            timeout: Math.floor(this.connOptions.timeoutMs),
          },
          tools,
        },
      });

      for await (const chunk of response) {
        if (chunk.promptFeedback) {
          throw new APIStatusError({
            message: `Prompt feedback error: ${JSON.stringify(chunk.promptFeedback)}`,
            options: {
              retryable: false,
              requestId,
            },
          });
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
    } catch (error: unknown) {
      const err = error as {
        code?: number;
        message?: string;
        status?: string;
        type?: string;
      };

      if (err.code && err.code >= 400 && err.code < 500) {
        if (err.code === 429) {
          throw new APIStatusError({
            message: `Google LLM: Rate limit error - ${err.message || 'Unknown error'}`,
            options: {
              statusCode: 429,
              retryable: true,
            },
          });
        } else {
          throw new APIStatusError({
            message: `Google LLM: Client error (${err.code}) - ${err.message || 'Unknown error'}`,
            options: {
              statusCode: err.code,
              retryable: false,
            },
          });
        }
      }

      if (err.code && err.code >= 500) {
        throw new APIStatusError({
          message: `Google LLM: Server error (${err.code}) - ${err.message || 'Unknown error'}`,
          options: {
            statusCode: err.code,
            retryable,
          },
        });
      }

      throw new APIConnectionError({
        message: `Google LLM: API error - ${err.message || 'Unknown error'}`,
        options: {
          retryable,
        },
      });
    }
  }

  #parsePart(id: string, part: types.Part): llm.ChatChunk | null {
    if (part.functionCall) {
      return {
        id,
        delta: {
          role: 'assistant',
          toolCalls: [
            llm.FunctionCall.create({
              callId: part.functionCall.id || shortuuid('function_call_'),
              name: part.functionCall.name!,
              args: JSON.stringify(part.functionCall.args!),
              // Preserve thought signature for Gemini 3+ thinking mode
              thoughtSignature: part.thoughtSignature,
            }),
          ],
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
