// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  GPTLiveModel as BaseGPTLiveModel,
  GPTLiveSession as BaseGPTLiveSession,
  type ResponsesDelegationOptions,
} from '../llm/openai_realtime/gpt_live_model.js';
import type { ErrorBody } from '../llm/openai_realtime/gpt_live_types.js';
import { RealtimeError } from '../llm/realtime.js';
import { type ToolContext, isFunctionTool } from '../llm/tool_context.js';
import type { APIConnectOptions } from '../types.js';
import {
  type AnyString,
  INFERENCE_PROVIDER_HEADER,
  buildMetadataHeaders,
  createAccessToken,
  getDefaultInferenceUrl,
  resolveCredentials,
} from './utils.js';

export type OpenAIDuplexModels = 'openai/gpt-live-1';

/** Full-duplex voice models served through LiveKit Inference. */
export type DuplexModels = OpenAIDuplexModels;

const DUPLEX_MODELS: ReadonlySet<string> = new Set<DuplexModels>(['openai/gpt-live-1']);

/** Whether a LiveKit Inference model string names a full-duplex voice model. */
export function isDuplexModel(model: string): model is DuplexModels {
  return DUPLEX_MODELS.has(model);
}

// the gateway refuses a session.start it cannot run; reconnecting resends the same one
const FATAL_ERROR_CODES = new Set([
  'invalid_model',
  'unsupported_server_tool',
  'unsupported_service_tier',
  'invalid_delegated_model',
  'unsupported_delegated_model',
]);

/** The backend Responses model GPT-Live delegates work to, under `delegation: 'responses'`. */
export type OpenAIResponsesOptions = Omit<ResponsesDelegationOptions, 'serviceTier'>;

export interface OpenAIDuplexOptions {
  /** Fixed at startup, `responses` by default. Client delegation requires an agent with no tools. */
  delegation?: 'responses' | 'client';
  /**
   * The backend Responses model when delegation is responses. Its model must be an OpenAI LLM
   * LiveKit Inference serves.
   */
  responsesOptions?: OpenAIResponsesOptions;
}

const OPENAI_DUPLEX_OPTIONS: ReadonlySet<string> = new Set<keyof OpenAIDuplexOptions>([
  'delegation',
  'responsesOptions',
]);

export type DuplexOptions<TModel extends DuplexModels | AnyString> =
  TModel extends OpenAIDuplexModels ? OpenAIDuplexOptions : Record<string, unknown>;

export interface DuplexModelOptions<TModel extends DuplexModels | AnyString> {
  /** Provider-prefixed duplex model, for example `openai/gpt-live-1`. */
  model: TModel;
  /**
   * Host that must serve the model, e.g. `'openai'`. The session is refused if no host in the
   * region matches.
   */
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  apiSecret?: string;
  /** Output voice, marin by default for GPT-Live. */
  voice?: string;
  /**
   * Model-specific options; `OpenAIDuplexOptions` for GPT-Live. Delegated work runs on the
   * default service tier only.
   */
  modelOptions?: DuplexOptions<TModel>;
  /** Recycle the connection after this many milliseconds. */
  maxSessionDuration?: number | null;
  connOptions?: APIConnectOptions;
}

interface InferenceOptions {
  provider?: string;
  apiKey: string;
  apiSecret: string;
}

/** Full-duplex voice model, served through LiveKit Inference. */
export class DuplexModel<
  TModel extends DuplexModels | AnyString = DuplexModels | AnyString,
> extends BaseGPTLiveModel {
  /** @internal */
  readonly _inferenceOptions: InferenceOptions;

  constructor(options: DuplexModelOptions<TModel>) {
    const { model } = options;
    if (!model.includes('/')) {
      throw new Error("model must be provider-prefixed, for example 'openai/gpt-live-1'");
    }
    const modelOptions = (options.modelOptions ?? {}) as OpenAIDuplexOptions;
    const unknown = Object.keys(modelOptions)
      .filter((key) => !OPENAI_DUPLEX_OPTIONS.has(key))
      .sort();
    if (unknown.length) {
      throw new Error(`unsupported modelOptions for ${model}: ${unknown.join(', ')}`);
    }
    const { delegation, responsesOptions } = modelOptions;
    const serviceTier = (responsesOptions as ResponsesDelegationOptions | undefined)?.serviceTier;
    if (serviceTier !== undefined && serviceTier !== 'default') {
      throw new Error('LiveKit Inference runs GPT-Live delegation on the default tier only');
    }
    const credentials = resolveCredentials(options.apiKey, options.apiSecret);

    super({
      model,
      ...(options.voice !== undefined ? { voice: options.voice } : {}),
      ...(delegation !== undefined ? { delegation } : {}),
      ...(responsesOptions !== undefined ? { responsesOptions } : {}),
      ...(options.maxSessionDuration !== undefined
        ? { maxSessionDuration: options.maxSessionDuration }
        : {}),
      ...(options.connOptions !== undefined ? { connOptions: options.connOptions } : {}),
      apiKey: 'livekit-inference',
      baseURL: options.baseURL || getDefaultInferenceUrl(),
    });
    this._inferenceOptions = {
      provider: options.provider,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
    };
  }

  static fromModelString(model: string): DuplexModel {
    return new DuplexModel({ model });
  }

  override get provider(): string {
    return 'livekit';
  }

  override label(): string {
    return 'inference.DuplexModel';
  }

  override session(): DuplexSession {
    return new DuplexSession(this);
  }
}

export class DuplexSession extends BaseGPTLiveSession {
  private readonly inferenceModel: DuplexModel;

  constructor(model: DuplexModel) {
    super(model);
    this.inferenceModel = model;
  }

  protected override async createWsUrlAndHeaders() {
    const { url } = await super.createWsUrlAndHeaders();
    const model = this.inferenceModel;
    const options = model._inferenceOptions;
    url.searchParams.set('model', model.model);
    const headers = buildMetadataHeaders();
    // signed per connection, so a reconnect never presents an expired token
    headers.Authorization = `Bearer ${await createAccessToken(options.apiKey, options.apiSecret)}`;
    if (options.provider) {
      headers[INFERENCE_PROVIDER_HEADER] = options.provider;
    }
    return { url, headers };
  }

  override async _updateTools(tools: ToolContext): Promise<void> {
    const hosted = tools
      .flatten()
      .filter((tool) => !isFunctionTool(tool))
      .map((tool) => tool.id)
      .sort();
    if (hosted.length) {
      // hosted tools bill separately from the delegated tokens the gateway meters
      throw new RealtimeError(
        `LiveKit Inference does not run hosted tools on GPT-Live, so the model can never call ${hosted.join(
          ', ',
        )}. Use function tools, or the OpenAI plugin's GPTLiveModel directly.`,
      );
    }
    await super._updateTools(tools);
  }

  protected override isFatalError(error: ErrorBody): boolean {
    return FATAL_ERROR_CODES.has(error.code || '') || super.isFatalError(error);
  }
}
