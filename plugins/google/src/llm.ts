// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { GoogleGenAI } from '@google/genai';
import { llm, log } from '@livekit/agents';
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
  toolChoice?: llm.ToolChoice;
  client?: GoogleGenAI;
}

const defaultLLMOptions: LLMOptions = {
  model: 'gemini-1.5-flash',
  apiKey: process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY,
};

export class LLM extends llm.LLM {
  #opts: LLMOptions;
  #client: GoogleGenAI;
  #logger = log();

  /**
   * Create a new instance of Google Gemini LLM.
   *
   * @remarks
   * For Google AI Studio: `apiKey` must be set via argument or `GOOGLE_API_KEY` env var.
   * For Vertex AI: Set `vertexai: true` and configure GCP authentication.
   */
  constructor(opts: Partial<LLMOptions> = {}) {
    super();

    this.#opts = { ...defaultLLMOptions, ...opts };

    // Set up authentication and client configuration
    const useVertexAI =
      this.#opts.vertexai ??
      (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' ||
        process.env.GOOGLE_GENAI_USE_VERTEXAI === '1');

    if (this.#opts.client) {
      this.#client = this.#opts.client;
    } else if (useVertexAI) {
      // Vertex AI configuration
      const project = this.#opts.project || process.env.GOOGLE_CLOUD_PROJECT;
      const location = this.#opts.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

      if (!project) {
        throw new Error(
          'Project ID is required for Vertex AI. Set via project option or GOOGLE_CLOUD_PROJECT environment variable',
        );
      }

      this.#client = new GoogleGenAI({
        vertexai: true,
        project,
        location,
      });
    } else {
      // Google AI Studio configuration
      if (!this.#opts.apiKey) {
        throw new Error(
          'API key is required for Google AI Studio. Set via apiKey option or GOOGLE_API_KEY environment variable',
        );
      }

      this.#client = new GoogleGenAI({
        apiKey: this.#opts.apiKey,
      });
    }
  }

  get model(): string {
    return this.#opts.model || 'gemini-1.5-flash';
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
    toolCtx?: llm.ToolContext;
    toolChoice?: llm.ToolChoice;
    temperature?: number;
    n?: number;
    parallelToolCalls?: boolean;
  }): LLMStream {
    temperature = temperature || this.#opts.temperature;
    toolChoice = toolChoice || this.#opts.toolChoice;

    return new LLMStream(
      this,
      this.#client,
      chatCtx,
      toolCtx,
      this.#opts,
      parallelToolCalls,
      temperature,
      n,
      toolChoice,
    );
  }
}

export class LLMStream extends llm.LLMStream {
  #client: GoogleGenAI;
  #opts: LLMOptions;
  #logger = log();
  label = 'google.LLMStream';

  constructor(
    llm: LLM,
    client: GoogleGenAI,
    chatCtx: llm.ChatContext,
    toolCtx: llm.ToolContext | undefined,
    opts: LLMOptions,
    parallelToolCalls?: boolean,
    temperature?: number,
    n?: number,
    toolChoice?: llm.ToolChoice,
  ) {
    super(llm, chatCtx, toolCtx);
    this.#client = client;
    this.#opts = opts;
    this.#run(opts, parallelToolCalls, temperature, n, toolChoice);
  }

  async #run(
    opts: LLMOptions,
    parallelToolCalls?: boolean,
    temperature?: number,
    n?: number,
    toolChoice?: llm.ToolChoice,
  ): Promise<void> {
    try {
      // Convert chat context to Google format
      const { messages, systemInstruction } = await this.#convertChatContext();

      // Convert tools if available
      const tools = this.toolCtx ? this.#convertTools() : [];

      // Prepare generation config
      const generationConfig: any = {};
      if (temperature !== undefined) {
        generationConfig.temperature = temperature;
      }
      if (opts.maxOutputTokens !== undefined) {
        generationConfig.maxOutputTokens = opts.maxOutputTokens;
      }
      if (opts.topP !== undefined) {
        generationConfig.topP = opts.topP;
      }
      if (opts.topK !== undefined) {
        generationConfig.topK = opts.topK;
      }

      // Prepare tool config
      let toolConfig: any = undefined;
      if (toolChoice && tools.length > 0) {
        toolConfig = this.#convertToolChoice(toolChoice);
      }

      // Create the request
      const request: any = {
        model: opts.model || 'gemini-1.5-flash',
        contents: messages,
        generationConfig,
      };

      if (systemInstruction) {
        request.systemInstruction = systemInstruction;
      }

      if (tools.length > 0) {
        request.tools = [{ functionDeclarations: tools }];
        if (toolConfig) {
          request.toolConfig = toolConfig;
        }
      }

      // Generate content stream
      const response = await this.#client.models.generateContentStream(request);

      let requestId = `google_${Date.now()}`;

      for await (const chunk of response) {
        const chatChunk = this.#convertChunk(requestId, chunk);
        if (chatChunk) {
          this.queue.put(chatChunk);
        }
      }
    } catch (error) {
      this.#logger.error(`Google LLM error: ${error}`);
      throw error;
    } finally {
      this.queue.close();
    }
  }

  async #convertChatContext(): Promise<{ messages: any[]; systemInstruction?: any }> {
    const messages: any[] = [];
    let systemInstruction: any = undefined;

    for (const item of this.chatCtx.items) {
      if (item instanceof llm.ChatMessage) {
        if (item.role === 'system') {
          systemInstruction = {
            role: 'system',
            parts: [{ text: item.content }],
          };
        } else {
          messages.push({
            role: item.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: item.content }],
          });
        }
      }
    }

    return { messages, systemInstruction };
  }

  #convertTools(): any[] {
    if (!this.toolCtx) return [];

    const tools: any[] = [];

    for (const [name, tool] of Object.entries(this.toolCtx)) {
      // Convert function signature to Google format
      const parameters = {
        type: 'object',
        properties: {} as Record<string, any>,
        required: [] as string[],
      };

      // Convert the tool parameters to JSON schema
      const functionTool = tool as llm.FunctionTool<any, any, any>;
      tools.push({
        name,
        description: functionTool.description || `Function: ${name}`,
        parameters: llm.toJsonSchema(functionTool.parameters) || parameters,
      });
    }

    return tools;
  }

  #convertToolChoice(toolChoice: llm.ToolChoice): any {
    if (typeof toolChoice === 'string') {
      switch (toolChoice) {
        case 'auto':
          return { functionCallingConfig: { mode: 'AUTO' } };
        case 'required':
          return { functionCallingConfig: { mode: 'ANY' } };
        case 'none':
          return { functionCallingConfig: { mode: 'NONE' } };
        default:
          return { functionCallingConfig: { mode: 'AUTO' } };
      }
    } else if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
      return {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [toolChoice.function.name],
        },
      };
    }

    return { functionCallingConfig: { mode: 'AUTO' } };
  }

  #convertChunk(requestId: string, chunk: any): llm.ChatChunk | null {
    if (!chunk.candidates || chunk.candidates.length === 0) {
      return null;
    }

    const candidate = chunk.candidates[0];
    if (!candidate.content || !candidate.content.parts) {
      return null;
    }

    let content = '';
    const toolCalls: llm.FunctionCall[] = [];

    for (const part of candidate.content.parts) {
      if (part.text) {
        content += part.text;
      } else if (part.functionCall) {
        toolCalls.push(
          llm.FunctionCall.create({
            callId: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: part.functionCall.name,
            args: JSON.stringify(part.functionCall.args || {}),
          }),
        );
      }
    }

    const delta: llm.ChoiceDelta = {
      role: 'assistant',
      content: content || undefined,
    };

    if (toolCalls.length > 0) {
      delta.toolCalls = toolCalls;
    }

    return {
      id: requestId,
      delta,
    };
  }
}
