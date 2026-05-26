// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { APIConnectOptions } from '@livekit/agents';
import { DEFAULT_API_CONNECT_OPTIONS, inference, llm } from '@livekit/agents';
import { GoogleAuth } from 'google-auth-library';
import OpenAI from 'openai';

/** @public */
export type ApiVersion = 'v1' | 'v1beta1';

/** @public */
export type AccessTokenProvider = () => string | Promise<string>;

/** @public */
export type GoogleCredentials = {
  getAccessToken: () => Promise<string | null | undefined | { token?: string | null }>;
};

/** @public */
export interface AIPlatformLLMOptions {
  /** Base DNS for the dedicated Model Garden endpoint, without path components. */
  endpointURL: string;
  /** Google Cloud project ID or number that owns the endpoint. */
  project: string;
  /** Numeric or UUID endpoint ID. */
  endpointId: string;
  location?: string;
  model?: string;
  accessToken?: string;
  credentials?: GoogleCredentials;
  tokenProvider?: AccessTokenProvider;
  apiVersion?: ApiVersion;
  temperature?: number;
  topP?: number;
  maxCompletionTokens?: number;
  parallelToolCalls?: boolean;
  toolChoice?: llm.ToolChoice;
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  extraQuery?: Record<string, string>;
  strictToolSchema?: boolean;
  client?: OpenAI;
  timeoutMs?: number;
}

type ResolvedAIPlatformLLMOptions = Required<
  Pick<AIPlatformLLMOptions, 'apiVersion' | 'location' | 'model' | 'strictToolSchema'>
> &
  Omit<AIPlatformLLMOptions, 'apiVersion' | 'location' | 'model' | 'strictToolSchema' | 'client'>;

function normalizeEndpointURL(endpointURL: string): string {
  let end = endpointURL.length;
  while (end > 0 && endpointURL[end - 1] === '/') {
    end -= 1;
  }
  return endpointURL.slice(0, end);
}

function resolveTokenProvider(opts: {
  accessToken?: string;
  credentials?: GoogleCredentials;
  tokenProvider?: AccessTokenProvider;
}): AccessTokenProvider {
  if (opts.tokenProvider) {
    return opts.tokenProvider;
  }

  if (opts.credentials) {
    return async () => {
      const accessToken = await opts.credentials!.getAccessToken();
      const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;
      if (!token) {
        throw new Error('Google credentials did not return an access token');
      }
      return token;
    };
  }

  if (opts.accessToken) {
    return () => opts.accessToken!;
  }

  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  let credentials: Promise<GoogleCredentials> | undefined;

  return async () => {
    credentials = credentials ?? (auth.getClient() as unknown as Promise<GoogleCredentials>);
    const accessToken = await (await credentials).getAccessToken();
    const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;
    if (!token) {
      throw new Error('Google application default credentials did not return an access token');
    }
    return token;
  };
}

function createGoogleAuthFetch(tokenProvider: AccessTokenProvider): typeof globalThis.fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${await tokenProvider()}`);
    return globalThis.fetch(input, { ...init, headers });
  };
}

/**
 * LLM for self-deployed Vertex AI Model Garden endpoints with OpenAI-compatible chat completions.
 *
 * @public
 */
export class AIPlatformLLM extends llm.LLM {
  #opts: ResolvedAIPlatformLLMOptions;
  #client: OpenAI;

  constructor(opts: AIPlatformLLMOptions) {
    super();

    const apiVersion = opts.apiVersion ?? 'v1beta1';
    const location = opts.location ?? 'us-central1';
    const model = opts.model ?? 'gemma';
    const strictToolSchema = opts.strictToolSchema ?? true;

    this.#opts = {
      ...opts,
      apiVersion,
      location,
      model,
      strictToolSchema,
    };

    if (opts.client) {
      this.#client = opts.client;
      return;
    }

    const baseURL = `${normalizeEndpointURL(opts.endpointURL)}/${apiVersion}/projects/${opts.project}/locations/${location}/endpoints/${opts.endpointId}`;
    this.#client = new OpenAI({
      apiKey: 'ignored-auth-comes-from-google-auth',
      baseURL,
      fetch: createGoogleAuthFetch(
        resolveTokenProvider({
          accessToken: opts.accessToken,
          credentials: opts.credentials,
          tokenProvider: opts.tokenProvider,
        }),
      ),
      maxRetries: 0,
      timeout: opts.timeoutMs,
    });
  }

  label(): string {
    return 'google.AIPlatformLLM';
  }

  get model(): string {
    return this.#opts.model;
  }

  get provider(): string {
    return 'Vertex AI Model Garden';
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    parallelToolCalls,
    toolChoice,
    extraKwargs,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): inference.LLMStream {
    const extras: Record<string, unknown> = { ...extraKwargs };

    if (this.#opts.temperature !== undefined) {
      extras.temperature = this.#opts.temperature;
    }
    if (this.#opts.topP !== undefined) {
      extras.top_p = this.#opts.topP;
    }
    if (this.#opts.maxCompletionTokens !== undefined) {
      extras.max_completion_tokens = this.#opts.maxCompletionTokens;
    }
    if (this.#opts.extraBody !== undefined) {
      extras.extra_body = this.#opts.extraBody;
    }
    if (this.#opts.extraHeaders !== undefined) {
      extras.extra_headers = this.#opts.extraHeaders;
    }
    if (this.#opts.extraQuery !== undefined) {
      extras.extra_query = this.#opts.extraQuery;
    }

    parallelToolCalls =
      parallelToolCalls !== undefined ? parallelToolCalls : this.#opts.parallelToolCalls;
    if (toolCtx && Object.keys(toolCtx).length > 0 && parallelToolCalls !== undefined) {
      extras.parallel_tool_calls = parallelToolCalls;
    }

    toolChoice = toolChoice !== undefined ? toolChoice : this.#opts.toolChoice;
    if (toolChoice !== undefined) {
      extras.tool_choice = toolChoice;
    }

    return new inference.LLMStream(this as unknown as inference.LLM, {
      model: this.#opts.model,
      providerFmt: 'openai',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: this.#client as any,
      chatCtx,
      toolCtx,
      connOptions,
      modelOptions: extras,
      strictToolSchema: this.#opts.strictToolSchema,
      gatewayOptions: undefined,
    });
  }
}
