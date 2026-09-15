// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import { DEFAULT_API_CONNECT_OPTIONS, inference, llm } from '@livekit/agents';
import OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { LLMModels } from './models.js';

export const SARVAM_LLM_BASE_URL_V1 = 'https://api.sarvam.ai/v1';
export const SARVAM_LLM_BASE_URL_V2 = 'https://api.sarvam.ai/v2';
export const USER_AGENT = `Livekit/${__PACKAGE_VERSION__} Node/${process.version}`;

const SUPPORTED_MODELS = new Set<LLMModels>([
  'gemma4',
  'sarvam-105b',
  'glm5.2',
  'sarvam-105b-conversations',
]);
const V1_MODELS = new Set<LLMModels>(['sarvam-105b-conversations']);
const VISION_MODELS = new Set<LLMModels>(['gemma4']);
const REASONING_EFFORT_MODELS = new Set<LLMModels>(['gemma4', 'sarvam-105b', 'glm5.2']);
const WIKI_GROUNDING_MODELS = new Set<LLMModels>(['gemma4', 'sarvam-105b', 'glm5.2']);
const UNSUPPORTED_OPENAI_FIELDS = new Set([
  'stream_options',
  'max_completion_tokens',
  'service_tier',
]);
const ALLOWED_EXTRA_BODY_PARAMS = new Set([
  'frequency_penalty',
  'max_tokens',
  'n',
  'presence_penalty',
  'seed',
  'stop',
  'wiki_grounding',
]);

/** @public */
export interface LLMOptions {
  model: LLMModels | string;
  apiKey?: string;
  baseURL?: string;
  client?: OpenAI;
  user?: string;
  temperature?: number;
  topP?: number;
  toolChoice?: llm.ToolChoice;
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  wikiGrounding?: boolean;
  stop?: string | string[];
  n?: number;
  seed?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
}

interface ResolvedLLMOptions {
  model: LLMModels;
  user?: string;
  temperature?: number;
  topP?: number;
  toolChoice?: llm.ToolChoice;
  reasoningEffort?: ReasoningEffort;
  extraHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
}

function resolveBaseURL(model: LLMModels): string {
  return V1_MODELS.has(model) ? SARVAM_LLM_BASE_URL_V1 : SARVAM_LLM_BASE_URL_V2;
}

function apiVersion(model: LLMModels): 'v1' | 'v2' {
  return V1_MODELS.has(model) ? 'v1' : 'v2';
}

function validateModel(model: string): LLMModels {
  if (!SUPPORTED_MODELS.has(model as LLMModels)) {
    throw new Error(
      `Unsupported Sarvam model '${model}'. Supported models: ${[...SUPPORTED_MODELS].sort().join(', ')}`,
    );
  }
  return model as LLMModels;
}

/** @internal */
export function _filterExtraBody(extraBody: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(extraBody).filter(([key]) => ALLOWED_EXTRA_BODY_PARAMS.has(key)),
  );
}

function hasImageContent(chatCtx: llm.ChatContext): boolean {
  return chatCtx.items.some(
    (item) =>
      item.type === 'message' &&
      item.role === 'user' &&
      item.content.some(
        (content) => typeof content !== 'string' && content.type === 'image_content',
      ),
  );
}

function createSarvamClient(params: {
  apiKey: string;
  baseURL: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}): OpenAI {
  return new OpenAI({
    apiKey: params.apiKey,
    baseURL: params.baseURL,
    maxRetries: 0,
    timeout: params.timeoutMs ?? 60_000,
    defaultHeaders: {
      ...params.extraHeaders,
      'api-subscription-key': params.apiKey,
      'User-Agent': USER_AGENT,
    },
  });
}

/** Sarvam OpenAI-compatible chat completions client. @public */
export class LLM extends llm.LLM {
  private _opts: ResolvedLLMOptions;
  private _client: OpenAI;
  private readonly _apiKey: string;
  private _apiVersion: 'v1' | 'v2';

  constructor(opts: Partial<LLMOptions> = {}) {
    super();

    const model = validateModel(opts.model ?? 'sarvam-105b');
    const apiKey = opts.apiKey ?? process.env.SARVAM_API_KEY;
    if (!apiKey) {
      throw new Error(
        'SARVAM_API_KEY is required, either as an argument or set SARVAM_API_KEY environment variable',
      );
    }

    const extraHeaders = {
      ...opts.extraHeaders,
      'api-subscription-key': apiKey,
      'User-Agent': USER_AGENT,
    };
    const extraBody: Record<string, unknown> = { ...opts.extraBody };
    if (opts.maxTokens !== undefined) extraBody.max_tokens = opts.maxTokens;
    if (opts.stop !== undefined) extraBody.stop = opts.stop;
    if (opts.n !== undefined) extraBody.n = opts.n;
    if (opts.seed !== undefined) extraBody.seed = opts.seed;
    if (opts.frequencyPenalty !== undefined) extraBody.frequency_penalty = opts.frequencyPenalty;
    if (opts.presencePenalty !== undefined) extraBody.presence_penalty = opts.presencePenalty;
    if (opts.wikiGrounding !== undefined && WIKI_GROUNDING_MODELS.has(model)) {
      extraBody.wiki_grounding = opts.wikiGrounding;
    }

    this._opts = {
      model,
      user: opts.user,
      temperature: opts.temperature,
      topP: opts.topP,
      toolChoice: opts.toolChoice,
      reasoningEffort: REASONING_EFFORT_MODELS.has(model) ? opts.reasoningEffort : undefined,
      extraHeaders,
      extraBody: _filterExtraBody(extraBody),
    };
    this._apiKey = apiKey;
    this._apiVersion = apiVersion(model);
    this._client =
      opts.client ??
      createSarvamClient({
        apiKey,
        baseURL: opts.baseURL ?? resolveBaseURL(model),
        extraHeaders: opts.extraHeaders,
        timeoutMs: opts.timeoutMs,
      });
  }

  override label(): string {
    return 'sarvam.LLM';
  }

  get model(): string {
    return this._opts.model;
  }

  get provider(): string {
    return 'Sarvam';
  }

  updateOptions(opts: { model?: LLMModels | string }): void {
    if (opts.model === undefined) return;

    const model = validateModel(opts.model);
    const version = apiVersion(model);
    if (version !== this._apiVersion) {
      this._client = createSarvamClient({ apiKey: this._apiKey, baseURL: resolveBaseURL(model) });
      this._apiVersion = version;
    }
    this._opts.model = model;
  }

  chat({
    chatCtx,
    toolCtx: toolCtxInput,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    parallelToolCalls,
    toolChoice,
    responseFormat,
    extraKwargs,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    responseFormat?: unknown;
    extraKwargs?: Record<string, unknown>;
  }): inference.LLMStream {
    const model = this._opts.model;
    if (!VISION_MODELS.has(model) && hasImageContent(chatCtx)) {
      throw new Error(
        `Image input is not supported for model '${model}'. Use 'gemma4' for vision capabilities.`,
      );
    }

    const toolCtx = llm.toToolContext(toolCtxInput);
    const effectiveToolChoice = toolChoice ?? this._opts.toolChoice;
    if (
      effectiveToolChoice !== undefined &&
      effectiveToolChoice !== 'none' &&
      effectiveToolChoice !== 'auto' &&
      (!toolCtx || toolCtx.flatten().length === 0)
    ) {
      throw new Error(
        "toolChoice requires a non-empty tool context. Provide tools or set toolChoice to 'none' or 'auto'.",
      );
    }

    const modelOptions: Record<string, unknown> = { ...extraKwargs };
    for (const field of UNSUPPORTED_OPENAI_FIELDS) delete modelOptions[field];
    if (!REASONING_EFFORT_MODELS.has(model)) delete modelOptions.reasoning_effort;

    Object.assign(modelOptions, this._opts.extraBody);
    if (this._opts.user !== undefined) modelOptions.user = this._opts.user;
    if (this._opts.temperature !== undefined) modelOptions.temperature = this._opts.temperature;
    if (this._opts.topP !== undefined) modelOptions.top_p = this._opts.topP;
    if (this._opts.reasoningEffort !== undefined) {
      modelOptions.reasoning_effort = this._opts.reasoningEffort;
    }
    if (responseFormat !== undefined) modelOptions.response_format = responseFormat;
    if (parallelToolCalls !== undefined) modelOptions.parallel_tool_calls = parallelToolCalls;
    if (effectiveToolChoice !== undefined) modelOptions.tool_choice = effectiveToolChoice;
    modelOptions.extra_headers = this._opts.extraHeaders;
    // Override the inference stream's default so this unsupported field is omitted on the wire.
    modelOptions.stream_options = undefined;

    return new inference.LLMStream(this as unknown as inference.LLM, {
      model,
      providerFmt: 'openai',
      client: this._client as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      chatCtx,
      toolCtx,
      connOptions,
      modelOptions,
      strictToolSchema: false,
    });
  }
}
