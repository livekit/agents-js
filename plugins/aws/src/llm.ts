// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  ConverseStreamCommandInput,
  Message,
  SystemContentBlock,
  Tool,
  ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import type { APIConnectOptions } from '@livekit/agents';
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
} from '@livekit/agents';
import { type AwsCredentials, createRequestSignal, resolveRegion } from './utils.js';

const DEFAULT_MODEL = 'amazon.nova-2-lite-v1:0';

interface AwsFormatData {
  systemMessages: string[] | null;
}

/** @public */
export interface LLMOptions {
  model?: string;
  region?: string;
  credentials?: AwsCredentials;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  toolChoice?: llm.ToolChoice;
  additionalRequestFields?: Record<string, unknown>;
  /** Caches system messages with a Bedrock prompt cache point to reduce token usage. */
  cacheSystem?: boolean;
  /** Caches tool definitions with a Bedrock prompt cache point to reduce token usage. */
  cacheTools?: boolean;
  client?: BedrockRuntimeClient;
}

/**
 * Builds a Bedrock Converse `ToolConfiguration` from a `ToolContext`, or `undefined` when the
 * turn should carry no tools (no tools registered, or `toolChoice: 'none'` was requested).
 * Kept module-local to the provider implementation; tests import the source module directly.
 */
export function buildToolConfig(
  toolCtx: llm.ToolContext | undefined,
  toolChoice: llm.ToolChoice | undefined,
  cacheTools: boolean,
): ToolConfiguration | undefined {
  if (!toolCtx || Object.keys(toolCtx.functionTools).length === 0) return undefined;
  if (toolChoice === 'none') return undefined;

  // The AWS SDK's `Tool` discriminated union requires a `$unknown` tuple on its catch-all
  // member, which defeats direct object-literal assignability checks against `Tool[]` here
  // (the same constraint the sibling google.ts/mistralai.ts adapters hit at this exact
  // ChatContext-to-SDK-type boundary) — build the array in its natural shape and cast once.
  const tools: Record<string, unknown>[] = llm.sortedToolEntries(toolCtx).map(([name, tool]) => ({
    toolSpec: {
      name,
      description: tool.description || '',
      inputSchema: {
        json: tool.parameters
          ? llm.toJsonSchema(tool.parameters, false, false)
          : { type: 'object', properties: {} },
      },
    },
  }));

  if (cacheTools) {
    tools.push({ cachePoint: { type: 'default' } });
  }

  const toolConfig: ToolConfiguration = { tools: tools as unknown as Tool[] };

  if (toolChoice === 'required') {
    toolConfig.toolChoice = { any: {} };
  } else if (toolChoice === 'auto') {
    toolConfig.toolChoice = { auto: {} };
  } else if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    toolConfig.toolChoice = { tool: { name: toolChoice.function.name } };
  }

  return toolConfig;
}

interface ConverseStreamException {
  message?: string;
  originalStatusCode?: number;
}

interface ConverseStreamExceptionEvent {
  validationException?: ConverseStreamException;
  throttlingException?: ConverseStreamException;
  internalServerException?: ConverseStreamException;
  modelStreamErrorException?: ConverseStreamException;
  serviceUnavailableException?: ConverseStreamException;
}

/** Whether a Bedrock HTTP failure can be retried before any output has been emitted. */
function isRetryableBedrockStatus(statusCode: number, retryable: boolean): boolean {
  return retryable && (statusCode === 408 || statusCode === 429 || statusCode >= 500);
}

const CONVERSE_STREAM_EXCEPTIONS: Array<{
  key: keyof ConverseStreamExceptionEvent;
  defaultMessage: string;
  statusCode?: number;
  retryable?: false;
}> = [
  {
    key: 'validationException',
    defaultMessage: 'validation error',
    statusCode: 400,
    retryable: false,
  },
  { key: 'throttlingException', defaultMessage: 'throttled', statusCode: 429 },
  { key: 'internalServerException', defaultMessage: 'internal server error', statusCode: 500 },
  { key: 'modelStreamErrorException', defaultMessage: 'model stream error', statusCode: 500 },
  { key: 'serviceUnavailableException', defaultMessage: 'service unavailable', statusCode: 503 },
];

/**
 * Resolves the HTTP status to report for a Converse stream exception.
 *
 * `modelStreamErrorException` often carries `originalStatusCode: 424` (Failed Dependency).
 * `APIStatusError` treats most 4xx as non-retryable, but AWS documents this event as a
 * transient stream failure — keep 5xx originals (and the configured default) so the LLM
 * retry loop can recover when no output has been emitted yet.
 */
function resolveConverseStreamStatusCode(
  key: keyof ConverseStreamExceptionEvent,
  exception: ConverseStreamException,
  statusCode: number | undefined,
): number | undefined {
  const original = exception.originalStatusCode;
  if (key === 'modelStreamErrorException') {
    if (original !== undefined && original >= 500) return original;
    return statusCode;
  }
  return original ?? statusCode;
}

/**
 * Bedrock delivers fatal mid-stream errors as regular `ConverseStreamOutput` union events
 * rather than thrown exceptions. Maps one to an `APIStatusError`, or `undefined` if the event
 * isn't one of the known exception shapes. Exported for unit testing.
 */
export function mapConverseStreamException(
  event: ConverseStreamExceptionEvent,
  requestId: string,
  retryable: boolean,
): APIStatusError | undefined {
  for (const {
    key,
    defaultMessage,
    statusCode,
    retryable: retryableOverride,
  } of CONVERSE_STREAM_EXCEPTIONS) {
    const exception = event[key];
    if (!exception) continue;

    return new APIStatusError({
      message: `aws bedrock llm: ${exception.message ?? defaultMessage}`,
      options: {
        statusCode: resolveConverseStreamStatusCode(key, exception, statusCode),
        retryable: retryableOverride ?? retryable,
        requestId,
      },
    });
  }
  return undefined;
}

/**
 * AWS Bedrock Converse LLM.
 * @public
 */
export class LLM extends llm.LLM {
  #opts;
  #client: BedrockRuntimeClient;
  #ownsClient: boolean;

  label(): string {
    return 'aws.LLM';
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'AWS Bedrock';
  }

  /**
   * Create a new instance of AWS Bedrock Converse LLM.
   *
   * @remarks
   * Credentials are resolved via the AWS SDK v3 default credential chain (environment
   * variables, shared config/credentials files, IMDS, etc.) unless `credentials` is provided
   * explicitly. The region is resolved from `region`, then `AWS_REGION`, then
   * `AWS_DEFAULT_REGION`, falling back to `us-east-1`. `model` defaults to
   * `BEDROCK_INFERENCE_PROFILE_ARN` if set, otherwise `amazon.nova-2-lite-v1:0`.
   */
  constructor(opts: LLMOptions = {}) {
    super();

    this.#opts = {
      model: opts.model ?? process.env.BEDROCK_INFERENCE_PROFILE_ARN ?? DEFAULT_MODEL,
      region: resolveRegion(opts.region),
      credentials: opts.credentials,
      temperature: opts.temperature,
      maxOutputTokens: opts.maxOutputTokens,
      topP: opts.topP,
      toolChoice: opts.toolChoice,
      additionalRequestFields: opts.additionalRequestFields,
      cacheSystem: opts.cacheSystem ?? false,
      cacheTools: opts.cacheTools ?? false,
    };

    this.#ownsClient = opts.client === undefined;
    this.#client =
      opts.client ??
      new BedrockRuntimeClient({
        region: this.#opts.region,
        credentials: opts.credentials,
        // The framework's own connOptions retry loop handles retries; disable the SDK's
        // internal retries so failures aren't retried twice (matches tts.ts's PollyClient).
        maxAttempts: 1,
      });
  }

  async aclose(): Promise<void> {
    if (this.#ownsClient) this.#client.destroy();
  }

  chat({
    chatCtx,
    toolCtx: toolCtxInput,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    toolChoice,
    extraKwargs,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): LLMStream {
    const toolCtx = llm.toToolContext(toolCtxInput);
    const resolvedToolChoice = toolChoice ?? this.#opts.toolChoice;

    const toolConfig = buildToolConfig(toolCtx, resolvedToolChoice, this.#opts.cacheTools);
    if (!toolConfig) {
      chatCtx = chatCtx.copy({ excludeFunctionCall: true });
    }

    const inferenceConfig: Record<string, unknown> = {};
    if (this.#opts.maxOutputTokens !== undefined)
      inferenceConfig.maxTokens = this.#opts.maxOutputTokens;
    if (this.#opts.temperature !== undefined) inferenceConfig.temperature = this.#opts.temperature;
    if (this.#opts.topP !== undefined) inferenceConfig.topP = this.#opts.topP;

    const extras: Record<string, unknown> = {
      inferenceConfig,
      ...(toolConfig ? { toolConfig } : {}),
      ...(this.#opts.additionalRequestFields
        ? { additionalModelRequestFields: this.#opts.additionalRequestFields }
        : {}),
      ...extraKwargs,
    };

    return new LLMStream(this, {
      client: this.#client,
      model: this.#opts.model,
      chatCtx,
      toolCtx,
      connOptions,
      cacheSystem: this.#opts.cacheSystem,
      extraKwargs: extras,
    });
  }
}

/** @public */
export class LLMStream extends llm.LLMStream {
  #client: BedrockRuntimeClient;
  #model: string;
  #cacheSystem: boolean;
  #extraKwargs: Record<string, unknown>;

  constructor(
    llmInst: LLM,
    {
      client,
      model,
      chatCtx,
      toolCtx,
      connOptions,
      cacheSystem,
      extraKwargs,
    }: {
      client: BedrockRuntimeClient;
      model: string;
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      cacheSystem: boolean;
      extraKwargs: Record<string, unknown>;
    },
  ) {
    super(llmInst, { chatCtx, toolCtx, connOptions });
    this.#client = client;
    this.#model = model;
    this.#cacheSystem = cacheSystem;
    this.#extraKwargs = extraKwargs;
  }

  protected async run(): Promise<void> {
    let retryable = true;
    let requestId = '';
    const request = createRequestSignal(this.abortController.signal, this.connOptions.timeoutMs);

    try {
      const [messages, extraData] = (await this.chatCtx.toProviderFormat('aws')) as [
        Record<string, unknown>[],
        AwsFormatData,
      ];

      const system: Record<string, unknown>[] = [];
      if (extraData.systemMessages) {
        for (const content of extraData.systemMessages) {
          system.push({ text: content });
        }
        if (this.#cacheSystem) {
          system.push({ cachePoint: { type: 'default' } });
        }
      }

      const input: ConverseStreamCommandInput = {
        modelId: this.#model,
        messages: messages as unknown as Message[],
        ...(system.length > 0 ? { system: system as unknown as SystemContentBlock[] } : {}),
        ...this.#extraKwargs,
      };

      const response = await this.#client.send(new ConverseStreamCommand(input), {
        abortSignal: request.signal,
      });
      requestId = response.$metadata.requestId ?? '';
      // `timeoutMs` bounds opening the streaming response, not generation time. Keep the
      // parent abort signal connected, but do not terminate a healthy long-running response.
      request.clearTimeout();

      if (!response.stream) {
        throw new APIStatusError({
          message: 'aws bedrock llm: no stream in the response',
          options: { retryable: false, requestId },
        });
      }

      let toolCallId: string | undefined;
      let fncName: string | undefined;
      let fncRawArgs: string | undefined;

      for await (const event of response.stream) {
        if (event.contentBlockStart?.start?.toolUse) {
          const toolUse = event.contentBlockStart.start.toolUse;
          toolCallId = toolUse.toolUseId;
          fncName = toolUse.name;
          fncRawArgs = '';
        } else if (event.contentBlockDelta?.delta) {
          const delta = event.contentBlockDelta.delta;
          if (delta.toolUse?.input !== undefined) {
            fncRawArgs = (fncRawArgs ?? '') + delta.toolUse.input;
          } else if (delta.text !== undefined) {
            this.queue.put({
              id: requestId,
              delta: { role: 'assistant', content: delta.text },
            });
            retryable = false;
          }
        } else if (event.contentBlockStop) {
          if (toolCallId !== undefined) {
            this.queue.put({
              id: requestId,
              delta: {
                role: 'assistant',
                toolCalls: [
                  llm.FunctionCall.create({
                    callId: toolCallId,
                    name: fncName ?? '',
                    args: fncRawArgs ?? '',
                  }),
                ],
              },
            });
            retryable = false;
            toolCallId = undefined;
            fncName = undefined;
            fncRawArgs = undefined;
          }
        } else if (event.metadata) {
          const usage = event.metadata.usage;
          if (usage) {
            this.queue.put({
              id: requestId,
              usage: {
                completionTokens: usage.outputTokens ?? 0,
                promptTokens: usage.inputTokens ?? 0,
                totalTokens: usage.totalTokens ?? 0,
                promptCachedTokens: usage.cacheReadInputTokens ?? 0,
              },
            });
          }
        } else {
          const mappedError = mapConverseStreamException(event, requestId, retryable);
          if (mappedError) {
            throw mappedError;
          }
        }
      }
    } catch (error: unknown) {
      if (request.didTimeout()) {
        throw new APITimeoutError({
          message: `aws bedrock llm: request timed out after ${this.connOptions.timeoutMs}ms`,
          options: { retryable },
        });
      }

      if (error instanceof APIStatusError || error instanceof APIConnectionError) {
        throw error;
      }

      // A user interruption aborts the in-flight Bedrock call; the resulting AbortError has
      // no HTTP status and would otherwise be classified as a retryable connection error,
      // causing the base LLMStream to fire an unwanted duplicate request on every barge-in.
      if (this.abortController.signal.aborted) {
        return;
      }

      const err = error as {
        message?: string;
        $metadata?: { httpStatusCode?: number; requestId?: string };
      };
      const statusCode = err.$metadata?.httpStatusCode;

      if (statusCode !== undefined) {
        throw new APIStatusError({
          message: `aws bedrock llm: ${err.message ?? 'unknown error'}`,
          options: {
            statusCode,
            retryable: isRetryableBedrockStatus(statusCode, retryable),
            requestId: err.$metadata?.requestId ?? requestId,
          },
        });
      }

      throw new APIConnectionError({
        message: `aws bedrock llm: ${err.message ?? String(error)}`,
        options: { retryable },
      });
    } finally {
      request.dispose();
    }
  }
}
