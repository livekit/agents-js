// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, log } from '@livekit/agents';
import { randomUUID } from 'node:crypto';
import { AzureOpenAI, OpenAI } from 'openai';
import sharp from 'sharp';
import type {
  CerebrasChatModels,
  ChatModels,
  DeepSeekChatModels,
  GroqChatModels,
  OctoChatModels,
  PerplexityChatModels,
  TelnyxChatModels,
  TogetherChatModels,
  XAIChatModels,
} from './models.js';

export interface LLMOptions {
  model: string | ChatModels;
  apiKey?: string;
  baseURL?: string;
  user?: string;
  temperature?: number;
  client?: OpenAI;
}

const defaultLLMOptions: LLMOptions = {
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
};

const defaultAzureLLMOptions: LLMOptions = {
  model: 'gpt-4o',
  apiKey: process.env.AZURE_API_KEY,
};

export class LLM extends llm.LLM {
  #opts: LLMOptions;
  #client: OpenAI;

  /**
   * Create a new instance of OpenAI LLM.
   *
   * @remarks
   * `apiKey` must be set to your OpenAI API key, either using the argument or by setting the
   * `OPENAI_API_KEY` environmental variable.
   */
  constructor(opts: Partial<LLMOptions> = defaultLLMOptions) {
    super();

    this.#opts = { ...defaultLLMOptions, ...opts };
    if (this.#opts.apiKey === undefined) {
      throw new Error('OpenAI API key is required, whether as an argument or as $OPENAI_API_KEY');
    }

    this.#client =
      this.#opts.client ||
      new OpenAI({
        baseURL: opts.baseURL,
        apiKey: opts.apiKey,
      });
  }

  /**
   * Create a new instance of OpenAI LLM with Azure.
   *
   * @remarks
   * This automatically infers the following arguments from their corresponding environment variables if they are not provided:
   * - `apiKey` from `AZURE_OPENAI_API_KEY`
   * - `organization` from `OPENAI_ORG_ID`
   * - `project` from `OPENAI_PROJECT_ID`
   * - `azureAdToken` from `AZURE_OPENAI_AD_TOKEN`
   * - `apiVersion` from `OPENAI_API_VERSION`
   * - `azureEndpoint` from `AZURE_OPENAI_ENDPOINT`
   */
  static withAzure(
    opts: {
      model: string | ChatModels;
      azureEndpoint?: string;
      azureDeployment?: string;
      apiVersion?: string;
      apiKey?: string;
      azureAdToken?: string;
      azureAdTokenProvider?: () => Promise<string>;
      organization?: string;
      project?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
    } = defaultAzureLLMOptions,
  ): LLM {
    opts = { ...defaultLLMOptions, ...opts };
    if (opts.apiKey === undefined) {
      throw new Error('Azure API key is required, whether as an argument or as $AZURE_API_KEY');
    }

    return new LLM({
      temperature: opts.temperature,
      user: opts.user,
      client: new AzureOpenAI(opts),
    });
  }

  /**
   * Create a new instance of Cerebras LLM.
   *
   * @remarks
   * `apiKey` must be set to your Cerebras API key, either using the argument or by setting the
   * `CEREBRAS_API_KEY` environmental variable.
   */
  static withCerebras(
    opts: Partial<{
      model: string | CerebrasChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.CEREBRAS_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error(
        'Cerebras API key is required, whether as an argument or as $CEREBRAS_API_KEY',
      );
    }

    return new LLM({
      model: 'llama3.1-8b',
      baseURL: 'https://api.cerebras.ai/v1',
      ...opts,
    });
  }

  /**
   * Create a new instance of Fireworks LLM.
   *
   * @remarks
   * `apiKey` must be set to your Fireworks API key, either using the argument or by setting the
   * `FIREWORKS_API_KEY` environmental variable.
   */
  static withFireworks(opts: Partial<LLMOptions> = {}): LLM {
    opts.apiKey = opts.apiKey || process.env.FIREWORKS_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error(
        'Fireworks API key is required, whether as an argument or as $FIREWORKS_API_KEY',
      );
    }

    return new LLM({
      model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
      baseURL: 'https://api.fireworks.ai/inference/v1',
      ...opts,
    });
  }

  /**
   * Create a new instance of xAI LLM.
   *
   * @remarks
   * `apiKey` must be set to your xAI API key, either using the argument or by setting the
   * `XAI_API_KEY` environmental variable.
   */
  static withXAI(
    opts: Partial<{
      model: string | XAIChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.XAI_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error('xAI API key is required, whether as an argument or as $XAI_API_KEY');
    }

    return new LLM({
      model: 'grok-2-public',
      baseURL: 'https://api.x.ai/v1',
      ...opts,
    });
  }

  /**
   * Create a new instance of Groq LLM.
   *
   * @remarks
   * `apiKey` must be set to your Groq API key, either using the argument or by setting the
   * `GROQ_API_KEY` environmental variable.
   */
  static withGroq(
    opts: Partial<{
      model: string | GroqChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.GROQ_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error('Groq API key is required, whether as an argument or as $GROQ_API_KEY');
    }

    return new LLM({
      model: 'llama3-8b-8192',
      baseURL: 'https://api.groq.com/openai/v1',
      ...opts,
    });
  }

  /**
   * Create a new instance of DeepSeek LLM.
   *
   * @remarks
   * `apiKey` must be set to your DeepSeek API key, either using the argument or by setting the
   * `DEEPSEEK_API_KEY` environmental variable.
   */
  static withDeepSeek(
    opts: Partial<{
      model: string | DeepSeekChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.DEEPSEEK_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error(
        'DeepSeek API key is required, whether as an argument or as $DEEPSEEK_API_KEY',
      );
    }

    return new LLM({
      model: 'deepseek-chat',
      baseURL: 'https://api.deepseek.com/v1',
      ...opts,
    });
  }

  /**
   * Create a new instance of OctoAI LLM.
   *
   * @remarks
   * `apiKey` must be set to your OctoAI API key, either using the argument or by setting the
   * `OCTOAI_TOKEN` environmental variable.
   */
  static withOcto(
    opts: Partial<{
      model: string | OctoChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.OCTOAI_TOKEN;
    if (opts.apiKey === undefined) {
      throw new Error('OctoAI API key is required, whether as an argument or as $OCTOAI_TOKEN');
    }

    return new LLM({
      model: 'llama-2-13b-chat',
      baseURL: 'https://text.octoai.run/v1',
      ...opts,
    });
  }

  /** Create a new instance of Ollama LLM. */
  static withOllama(
    opts: Partial<{
      model: string;
      baseURL?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    return new LLM({
      model: 'llama-2-13b-chat',
      baseURL: 'https://text.octoai.run/v1',
      apiKey: 'ollama',
      ...opts,
    });
  }

  /**
   * Create a new instance of PerplexityAI LLM.
   *
   * @remarks
   * `apiKey` must be set to your PerplexityAI API key, either using the argument or by setting the
   * `PERPLEXITY_API_KEY` environmental variable.
   */
  static withPerplexity(
    opts: Partial<{
      model: string | PerplexityChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.PERPLEXITY_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error(
        'PerplexityAI API key is required, whether as an argument or as $PERPLEXITY_API_KEY',
      );
    }

    return new LLM({
      model: 'llama-3.1-sonar-small-128k-chat',
      baseURL: 'https://api.perplexity.ai',
      ...opts,
    });
  }

  /**
   * Create a new instance of TogetherAI LLM.
   *
   * @remarks
   * `apiKey` must be set to your TogetherAI API key, either using the argument or by setting the
   * `TOGETHER_API_KEY` environmental variable.
   */
  static withTogether(
    opts: Partial<{
      model: string | TogetherChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.TOGETHER_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error(
        'TogetherAI API key is required, whether as an argument or as $TOGETHER_API_KEY',
      );
    }

    return new LLM({
      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
      baseURL: 'https://api.together.xyz/v1',
      ...opts,
    });
  }

  /**
   * Create a new instance of Telnyx LLM.
   *
   * @remarks
   * `apiKey` must be set to your Telnyx API key, either using the argument or by setting the
   * `TELNYX_API_KEY` environmental variable.
   */
  static withTelnyx(
    opts: Partial<{
      model: string | TelnyxChatModels;
      apiKey?: string;
      baseURL?: string;
      user?: string;
      temperature?: number;
      client: OpenAI;
    }> = {},
  ): LLM {
    opts.apiKey = opts.apiKey || process.env.TELNYX_API_KEY;
    if (opts.apiKey === undefined) {
      throw new Error('Telnyx API key is required, whether as an argument or as $TELNYX_API_KEY');
    }

    return new LLM({
      model: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
      baseURL: 'https://api.telnyx.com/v2/ai',
      ...opts,
    });
  }

  chat({
    chatCtx,
    fncCtx,
    temperature,
    n,
    parallelToolCalls,
  }: {
    chatCtx: llm.ChatContext;
    fncCtx?: llm.FunctionContext | undefined;
    temperature?: number | undefined;
    n?: number | undefined;
    parallelToolCalls?: boolean | undefined;
  }): LLMStream {
    temperature = temperature || this.#opts.temperature;

    return new LLMStream(
      this,
      this.#client,
      chatCtx,
      fncCtx,
      this.#opts,
      parallelToolCalls,
      temperature,
      n,
    );
  }
}

export class LLMStream extends llm.LLMStream {
  #toolCallId?: string;
  #fncName?: string;
  #fncRawArguments?: string;
  #client: OpenAI;
  #logger = log();
  #id = randomUUID();
  label = 'openai.LLMStream';

  constructor(
    llm: LLM,
    client: OpenAI,
    chatCtx: llm.ChatContext,
    fncCtx: llm.FunctionContext | undefined,
    opts: LLMOptions,
    parallelToolCalls?: boolean,
    temperature?: number,
    n?: number,
  ) {
    super(llm, chatCtx, fncCtx);
    this.#client = client;
    this.#run(opts, n, parallelToolCalls, temperature);
  }

  async #run(opts: LLMOptions, n?: number, parallelToolCalls?: boolean, temperature?: number) {
    const tools = this.fncCtx
      ? Object.entries(this.fncCtx).map(([name, func]) => ({
          type: 'function' as const,
          function: {
            name,
            description: func.description,
            // don't format parameters if they are raw openai params
            parameters:
              func.parameters.type == ('object' as const)
                ? func.parameters
                : llm.oaiParams(func.parameters),
          },
        }))
      : undefined;

    try {
      const stream = await this.#client.chat.completions.create({
        model: opts.model,
        user: opts.user,
        n,
        messages: await Promise.all(
          this.chatCtx.messages.map(async (m) => await buildMessage(m, this.#id)),
        ),
        temperature: temperature || opts.temperature,
        stream_options: { include_usage: true },
        stream: true,
        tools,
        parallel_tool_calls: this.fncCtx && parallelToolCalls,
      });

      for await (const chunk of stream) {
        for (const choice of chunk.choices) {
          const chatChunk = this.#parseChoice(chunk.id, choice);
          if (chatChunk) {
            this.queue.put(chatChunk);
          }

          if (chunk.usage) {
            const usage = chunk.usage;
            this.queue.put({
              requestId: chunk.id,
              choices: [],
              usage: {
                completionTokens: usage.completion_tokens,
                promptTokens: usage.prompt_tokens,
                totalTokens: usage.total_tokens,
              },
            });
          }
        }
      }
    } finally {
      this.queue.close();
    }
  }

  #parseChoice(id: string, choice: OpenAI.ChatCompletionChunk.Choice): llm.ChatChunk | undefined {
    const delta = choice.delta;

    if (delta.tool_calls) {
      // check if we have functions to calls
      for (const tool of delta.tool_calls) {
        if (!tool.function) {
          continue; // oai may add other tools in the future
        }

        let callChunk: llm.ChatChunk | undefined;
        if (this.#toolCallId && tool.id && tool.id !== this.#toolCallId) {
          callChunk = this.#tryBuildFunction(id, choice);
        }

        if (tool.function.name) {
          this.#toolCallId = tool.id;
          this.#fncName = tool.function.name;
          this.#fncRawArguments = tool.function.arguments || '';
        } else if (tool.function.arguments) {
          this.#fncRawArguments += tool.function.arguments;
        }

        if (callChunk) {
          return callChunk;
        }
      }
    }

    if (
      choice.finish_reason &&
      ['tool_calls', 'stop'].includes(choice.finish_reason) &&
      this.#toolCallId
    ) {
      // we're done with the tool calls, run the last one
      return this.#tryBuildFunction(id, choice);
    }

    return {
      requestId: id,
      choices: [
        {
          delta: { content: delta.content || undefined, role: llm.ChatRole.ASSISTANT },
          index: choice.index,
        },
      ],
    };
  }

  #tryBuildFunction(
    id: string,
    choice: OpenAI.ChatCompletionChunk.Choice,
  ): llm.ChatChunk | undefined {
    if (!this.fncCtx) {
      this.#logger.warn('oai stream tried to run function without function context');
      return undefined;
    }

    if (!this.#toolCallId) {
      this.#logger.warn('oai stream tried to run function but toolCallId is not set');
      return undefined;
    }

    if (!this.#fncRawArguments || !this.#fncName) {
      this.#logger.warn('oai stream tried to run function but rawArguments or fncName are not set');
      return undefined;
    }

    const functionInfo = llm.oaiBuildFunctionInfo(
      this.fncCtx,
      this.#toolCallId,
      this.#fncName,
      this.#fncRawArguments,
    );
    this.#toolCallId = this.#fncName = this.#fncRawArguments = undefined;
    this._functionCalls.push(functionInfo);

    return {
      requestId: id,
      choices: [
        {
          delta: {
            content: choice.delta.content || undefined,
            role: llm.ChatRole.ASSISTANT,
            toolCalls: this._functionCalls,
          },
          index: choice.index,
        },
      ],
    };
  }
}

const buildMessage = async (msg: llm.ChatMessage, cacheKey: any) => {
  const oaiMsg: Partial<OpenAI.ChatCompletionMessageParam> = {};

  switch (msg.role) {
    case llm.ChatRole.SYSTEM:
      oaiMsg.role = 'system';
      break;
    case llm.ChatRole.USER:
      oaiMsg.role = 'user';
      break;
    case llm.ChatRole.ASSISTANT:
      oaiMsg.role = 'assistant';
      break;
    case llm.ChatRole.TOOL:
      oaiMsg.role = 'tool';
      if (oaiMsg.role === 'tool') {
        oaiMsg.tool_call_id = msg.toolCallId;
      }
      break;
  }

  if (typeof msg.content === 'string') {
    oaiMsg.content = msg.content;
  } else if (Array.isArray(msg.content)) {
    oaiMsg.content = (await Promise.all(
      msg.content.map(async (c) => {
        if (typeof c === 'string') {
          return { type: 'text', text: c };
        } else if (
          // typescript type guard for determining ChatAudio vs ChatImage
          ((c: llm.ChatAudio | llm.ChatImage): c is llm.ChatImage => {
            return (c as llm.ChatImage).image !== undefined;
          })(c)
        ) {
          return await buildImageContent(c, cacheKey);
        } else {
          throw new Error('ChatAudio is not supported');
        }
      }),
    )) as OpenAI.ChatCompletionContentPart[];
  } else if (msg.content === undefined) {
    oaiMsg.content = '';
  }

  // make sure to provide when function has been called inside the context
  // (+ raw_arguments)
  if (msg.toolCalls && oaiMsg.role === 'assistant') {
    oaiMsg.tool_calls = Object.entries(msg.toolCalls).map(([name, func]) => ({
      id: func.toolCallId,
      type: 'function' as const,
      function: {
        name: name,
        arguments: func.rawParams,
      },
    }));
  }

  return oaiMsg as OpenAI.ChatCompletionMessageParam;
};

const buildImageContent = async (image: llm.ChatImage, cacheKey: any) => {
  if (typeof image.image === 'string') {
    // image url
    return {
      type: 'image_url',
      image_url: {
        url: image.image,
        detail: 'auto',
      },
    };
  } else {
    if (!image.cache[cacheKey]) {
      // inside our internal implementation, we allow to put extra metadata to
      // each ChatImage (avoid to reencode each time we do a chatcompletion request)
      let encoded = sharp(image.image.data);

      if (image.inferenceHeight && image.inferenceHeight) {
        encoded = encoded.resize(image.inferenceWidth, image.inferenceHeight);
      }

      image.cache[cacheKey] = await encoded
        .jpeg()
        .toBuffer()
        .then((buffer) => buffer.toString('utf-8'));
    }

    return {
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${image.cache[cacheKey]}`,
      },
    };
  }
};
