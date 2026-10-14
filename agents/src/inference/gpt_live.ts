// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  GPTLiveModel as BaseGPTLiveModel,
  GPTLiveSession as BaseGPTLiveSession,
  type GPTLiveVoices,
  type ResponsesDelegationOptions,
} from '../llm/openai_realtime/gpt_live_model.js';
import type { DelegationTarget, ErrorBody } from '../llm/openai_realtime/gpt_live_types.js';
import { RealtimeError } from '../llm/realtime.js';
import { type ToolContext, isFunctionTool } from '../llm/tool_context.js';
import type { APIConnectOptions } from '../types.js';
import {
  type AnyString,
  INFERENCE_PROVIDER_HEADER,
  type InferenceClass,
  buildMetadataHeaders,
  createAccessToken,
  getDefaultInferenceUrl,
  resolveCredentials,
} from './utils.js';

/** GPT-Live models served through LiveKit Inference. */
export type OpenAIGPTLiveModels = 'openai/gpt-live-1';

const GPT_LIVE_MODELS: ReadonlySet<string> = new Set<OpenAIGPTLiveModels>(['openai/gpt-live-1']);

/** Whether a LiveKit Inference model string names a GPT-Live model. */
export function isGPTLiveModel(model: string): model is OpenAIGPTLiveModels {
  return GPT_LIVE_MODELS.has(model);
}

// the gateway refuses a session.start it cannot run; reconnecting resends the same one
const FATAL_ERROR_CODES = new Set([
  'invalid_model',
  'unsupported_server_tool',
  'unsupported_service_tier',
  'invalid_delegated_model',
  'unsupported_delegated_model',
]);

export interface GPTLiveModelOptions {
  /** Provider-prefixed GPT-Live model. Defaults to openai/gpt-live-1. */
  model?: OpenAIGPTLiveModels | AnyString;
  /**
   * Host that must serve the model, e.g. `'openai'`. The session is refused if no host in the
   * region matches.
   */
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  apiSecret?: string;
  /** Has no effect on GPT-Live sessions. */
  inferenceClass?: InferenceClass;
  /** A named voice (marin by default), or an authorized custom voice object. */
  voice?: GPTLiveVoices | AnyString | Record<string, unknown>;
  /** Fixed at startup. Client delegation requires an agent with no tools. */
  delegation?: DelegationTarget;
  /**
   * The backend Responses model when delegation is responses. Its model must be an OpenAI LLM
   * LiveKit Inference serves, and only the default serviceTier is billed, so no other is accepted.
   */
  responsesOptions?: ResponsesDelegationOptions;
  /** Recycle the connection after this many milliseconds. */
  maxSessionDuration?: number | null;
  connOptions?: APIConnectOptions;
}

interface InferenceOptions {
  provider?: string;
  apiKey: string;
  apiSecret: string;
  inferenceClass?: InferenceClass;
}

/** OpenAI GPT-Live full-duplex voice model, served through LiveKit Inference. */
export class GPTLiveModel extends BaseGPTLiveModel {
  /** @internal */
  readonly _inferenceOptions: InferenceOptions;

  constructor(options: GPTLiveModelOptions = {}) {
    const model = options.model ?? 'openai/gpt-live-1';
    if (!model.includes('/')) {
      throw new Error("model must be provider-prefixed, for example 'openai/gpt-live-1'");
    }
    const serviceTier = options.responsesOptions?.serviceTier;
    if (serviceTier !== undefined && serviceTier !== 'default') {
      throw new Error('LiveKit Inference runs GPT-Live delegation on the default tier only');
    }
    const credentials = resolveCredentials(options.apiKey, options.apiSecret);

    super({
      model,
      ...(options.voice !== undefined ? { voice: options.voice } : {}),
      ...(options.delegation !== undefined ? { delegation: options.delegation } : {}),
      ...(options.responsesOptions !== undefined
        ? { responsesOptions: options.responsesOptions }
        : {}),
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
      inferenceClass: options.inferenceClass,
    };
  }

  static fromModelString(model: string): GPTLiveModel {
    return new GPTLiveModel({ model });
  }

  override get provider(): string {
    return 'livekit';
  }

  override label(): string {
    return 'inference.GPTLiveModel';
  }

  override session(): GPTLiveSession {
    return new GPTLiveSession(this);
  }
}

export class GPTLiveSession extends BaseGPTLiveSession {
  private readonly inferenceModel: GPTLiveModel;

  constructor(model: GPTLiveModel) {
    super(model);
    this.inferenceModel = model;
  }

  protected override async createWsUrlAndHeaders() {
    const { url } = await super.createWsUrlAndHeaders();
    const model = this.inferenceModel;
    const options = model._inferenceOptions;
    url.searchParams.set('model', model.model);
    const headers = buildMetadataHeaders(options.inferenceClass);
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
