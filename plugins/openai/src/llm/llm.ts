// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, log } from '@livekit/agents';
import { OpenAI } from 'openai';
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
}

const defaultLLMOptions: LLMOptions = {
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY,
};

export class LLM extends llm.LLM {
  #opts: LLMOptions;
  #client: OpenAI;

  constructor(opts: Partial<LLMOptions> = defaultLLMOptions) {
    super();

    this.#opts = { ...defaultLLMOptions, ...opts };

    if (this.#opts.apiKey === undefined) {
      throw new Error('OpenAI API key is required, whether as an argument or as $OPENAI_API_KEY');
    }

    this.#client = new OpenAI({
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
    });
  }

  // TODO(nbsp): with* adapters

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
    const tools = fncCtx
      ? Object.entries(fncCtx).map(([name, func]) => ({
          type: 'function' as const,
          function: {
            name,
            description: func.description,
            parameters: llm.oaiParams(func.parameters),
          },
        }))
      : [];

    temperature = temperature || this.#opts.temperature;

    const oaiStream = this.#client.chat.completions.create({
      model: this.#opts.model,
      user: this.#opts.user,
      n,
      messages: chatCtx.messages.map((m) => buildMessage(m, '')), // TODO(nbsp): identifier https://stackoverflow.com/questions/1997661/unique-object-identifier-in-javascript
      temperature,
      stream_options: { include_usage: true },
      stream: true,
      tools,
      parallel_tool_calls: fncCtx && parallelToolCalls,
    });

    return new LLMStream(chatCtx, fncCtx, oaiStream);
  }
}

export class LLMStream extends llm.LLMStream {
  #awaitableOaiStream: Promise<AsyncIterable<OpenAI.ChatCompletionChunk>>;
  #oaiStream?: AsyncIterable<OpenAI.ChatCompletionChunk>;
  #toolCallId?: string;
  #fncName?: string;
  #fncRawArguments?: string;
  #logger = log();

  constructor(
    chatCtx: llm.ChatContext,
    fncCtx: llm.FunctionContext | undefined,
    oaiStream: Promise<AsyncIterable<OpenAI.ChatCompletionChunk>>,
  ) {
    super(chatCtx, fncCtx);
    this.#awaitableOaiStream = oaiStream;

    this.#run();
  }

  async #run() {
    if (!this.#oaiStream) {
      this.#oaiStream = await this.#awaitableOaiStream;
    }

    for await (const chunk of this.#oaiStream) {
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
  }

  #parseChoice(id: string, choice: OpenAI.ChatCompletionChunk.Choice): llm.ChatChunk | undefined {
    const delta = choice.delta;

    if (delta.tool_calls) {
      // check if we have functions to calls
      for (const tool of delta.tool_calls) {
        if (!tool.function) {
          continue; // oai may add other tools in the future
        }

        if (tool.function.name) {
          this.#toolCallId = tool.id;
          this.#fncName = tool.function.name;
          this.#fncRawArguments = tool.function.arguments || '';
        } else if (tool.function.arguments) {
          this.#fncRawArguments += tool.function.arguments;
        }

        if (this.#toolCallId && tool.id && tool.id !== this.#toolCallId) {
          return this.#tryBuildFunction(id, choice);
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

    this.#toolCallId = this.#fncName = this.#fncRawArguments = undefined;
    // TODO(nbsp): create ai function info

    return {
      requestId: id,
      choices: [
        {
          delta: {
            content: choice.delta.content || undefined,
            role: llm.ChatRole.ASSISTANT,
            toolCalls: this.fncCtx,
          },
          index: choice.index,
        },
      ],
    };
  }
}

const buildMessage = (msg: llm.ChatMessage, cacheKey: any) => {
  let oaiMsg: Partial<OpenAI.ChatCompletionMessageParam> = {};

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
      oaiMsg = oaiMsg as Partial<OpenAI.ChatCompletionToolMessageParam>;
      oaiMsg.role = 'tool';
      oaiMsg.tool_call_id = msg.toolCallId;
      break;
  }

  if (typeof msg.content === 'string') {
    oaiMsg.content = msg.content;
  } else if (
    ((c?: llm.ChatContent | llm.ChatContent[]): c is llm.ChatContent[] => {
      return (c as llm.ChatContent[]).length !== undefined;
    })(msg.content)
  ) {
    oaiMsg.content = msg.content.map((c) => {
      if (typeof c === 'string') {
        return { type: 'text', text: c };
      } else if (
        // typescript type guard for determining ChatAudio vs ChatImage
        ((c: llm.ChatAudio | llm.ChatImage): c is llm.ChatImage => {
          return (c as llm.ChatImage).image !== undefined;
        })(c)
      ) {
        return buildImageContent(c, cacheKey);
      } else {
        throw new Error('ChatAudio is not supported');
      }
    }) as OpenAI.ChatCompletionContentPart[];
  }

  // TODO(nbsp): deferred function support inside chatmessage
  // // make sure to provide when function has been called inside the context
  // // (+ raw_arguments)
  // if (msg.toolCalls) {
  //   oaiMsg.tool_calls = Object.entries(msg.toolCalls).map(([name, func]) => ({
  //     id: msg.toolCallId,
  //     type: 'function' as const,
  //     function: {
  //       name: name,
  //       arguments
  //     }
  //   }))
  // }

  return oaiMsg as OpenAI.ChatCompletionMessageParam;
};

const buildImageContent = (image: llm.ChatImage, cacheKey: any) => {
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
      // TODO(nbsp): resize image and encode to base64
    }

    return {
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${image.cache[cacheKey]}`,
      },
    };
  }
};
