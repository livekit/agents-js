// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { shortuuid } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-openai';
import { WebSocket } from 'ws';
import type { ProviderData } from './provider_data.js';

const { RealtimeModel: OpenAIRealtimeModel, RealtimeSession: OpenAIRealtimeSession } = realtime;

type OpenAIRealtimeModelOptions = NonNullable<ConstructorParameters<typeof OpenAIRealtimeModel>[0]>;

// Ref: python livekit-plugins/livekit-plugins-inworld/livekit/plugins/inworld/realtime/realtime_model.py
const DEFAULT_WS_URL = 'wss://api.inworld.ai/api/v1/realtime/session';
const DEFAULT_LLM_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_TTS_MODEL = 'inworld-tts-2';
const DEFAULT_STT_MODEL = 'inworld/inworld-stt-1';
const DEFAULT_VOICE = 'Ashley';

const USER_AGENT = 'LiveKit Agents';

/**
 * Inworld's `session.audio.output` carries a `model` field selecting the TTS model. The OpenAI
 * `RealtimeAudioConfigOutput` interface has no such field, so widen it locally.
 */
type InworldAudioConfigOutput = realtime.RealtimeAudioConfigOutput & { model?: string };

/**
 * Inworld's `session` object carries a `providerData` bag of Inworld-specific options. The OpenAI
 * `SessionUpdateEvent['session']` type has no such field, so widen it locally.
 */
type InworldSessionUpdate = realtime.SessionUpdateEvent['session'] & {
  providerData?: ProviderData;
  audio?: realtime.SessionUpdateEvent['session']['audio'] & {
    output?: InworldAudioConfigOutput;
  };
};

/** Options for {@link RealtimeModel}. */
export interface RealtimeModelOptions
  extends Omit<OpenAIRealtimeModelOptions, 'model' | 'baseURL' | 'azureDeployment' | 'apiVersion'> {
  /**
   * The LLM to run the conversation, in `provider/model` form.
   *
   * @defaultValue `'openai/gpt-4o-mini'`
   */
  model?: string;
  /**
   * The Inworld TTS model used for audio output.
   *
   * @defaultValue `'inworld-tts-2'`
   */
  ttsModel?: string;
  /**
   * The Inworld STT model used for user transcription, in `provider/model` form.
   *
   * Ignored when `inputAudioTranscription` is supplied explicitly.
   *
   * @defaultValue `'inworld/inworld-stt-1'`
   */
  sttModel?: string;
  /**
   * The Inworld voice for audio output.
   *
   * @defaultValue `'Ashley'`
   */
  voice?: string;
  /**
   * Inworld API key. Falls back to `$INWORLD_API_KEY`.
   *
   * The Inworld key is already base64-encoded and is sent as an HTTP `Basic` credential.
   */
  apiKey?: string;
  /**
   * WebSocket endpoint for the Realtime session.
   *
   * `http://` and `https://` are rewritten to `ws://` and `wss://` respectively.
   *
   * @defaultValue `'wss://api.inworld.ai/api/v1/realtime/session'`
   */
  baseURL?: string;
  /**
   * Inworld-specific session options, merged over `{ auto_tool_response: false }`.
   *
   * @see {@link ProviderData}
   */
  providerData?: ProviderData;
}

/**
 * Build the Inworld Realtime WebSocket URL.
 *
 * Deliberately does **not** use the OpenAI plugin's `processBaseURL` helper: that helper appends a
 * `/realtime` path segment and a `?model=` query parameter, neither of which Inworld accepts.
 *
 * The scheme of `baseURL` is respected: `http://` maps to `ws://`, `https://` maps to `wss://`.
 * A `key` query parameter is generated if absent and preserved if the caller supplied one.
 *
 * @internal Exported for testing purposes.
 */
export function buildWsUrl(baseURL: string): string {
  const url = new URL(baseURL);

  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }

  if (!url.searchParams.get('key')) {
    url.searchParams.set('key', shortuuid('session_'));
  }
  url.searchParams.set('protocol', 'realtime');

  return url.toString();
}

/**
 * A Realtime model backed by the Inworld Realtime API.
 *
 * Inworld speaks the OpenAI Realtime wire protocol, so this subclasses the OpenAI plugin's
 * {@link realtime.RealtimeModel} and overrides only auth, the URL shape, and the Inworld-specific
 * fields on the initial `session.update`.
 *
 * @example
 * ```ts
 * const model = new RealtimeModel({
 *   voice: 'Ashley',
 *   providerData: { tts: { delivery_mode: 'BALANCED' } },
 * });
 * ```
 */
export class RealtimeModel extends OpenAIRealtimeModel {
  /** @internal */
  _ttsModel: string;
  /** @internal */
  _providerData: ProviderData;

  override label(): string {
    return 'inworld.RealtimeModel';
  }

  /**
   * The provider name reported in metrics and traces.
   *
   * Overridden because the base implementation derives this from the URL host, which would yield
   * `api.inworld.ai`.
   */
  override get provider(): string {
    return 'Inworld';
  }

  constructor(options: RealtimeModelOptions = {}) {
    const apiKey = options.apiKey ?? process.env.INWORLD_API_KEY;
    if (!apiKey) {
      throw new Error('Inworld API key is required, whether as an argument or as $INWORLD_API_KEY');
    }

    const {
      ttsModel: _ttsModel,
      sttModel,
      providerData: _providerData,
      ...openaiOptions
    } = options;

    super({
      ...openaiOptions,
      apiKey,
      baseURL: options.baseURL ?? DEFAULT_WS_URL,
      model: options.model ?? DEFAULT_LLM_MODEL,
      voice: options.voice ?? DEFAULT_VOICE,
      modalities: options.modalities ?? ['text', 'audio'],
      inputAudioTranscription:
        options.inputAudioTranscription === undefined
          ? { model: sttModel ?? DEFAULT_STT_MODEL }
          : options.inputAudioTranscription,
    });

    // Safe to assign after super(): the `useDefineForClassFields` ordering trap only affects the
    // session, whose overridden hooks run *during* the base constructor.
    this._ttsModel = options.ttsModel ?? DEFAULT_TTS_MODEL;
    this._providerData = { auto_tool_response: false, ...options.providerData };
  }

  override session(): RealtimeSession {
    return new RealtimeSession(this);
  }
}

/**
 * A session against the Inworld Realtime API.
 *
 * Like the base OpenAI session, this also emits the raw `openai_server_event_received` and
 * `openai_client_event_queued` events, which are the fastest way to debug wire-level issues.
 *
 * ## Implementation constraint: no instance fields
 *
 * Both overridden hooks below run *inside* the base class constructor — `createWsConn` via the main
 * task that `super()` kicks off synchronously, and `createSessionUpdateEvent` on the last line of
 * `super()`. Because the repo compiles with `useDefineForClassFields`, any field declared on this
 * subclass is defined to `undefined` only *after* `super()` returns, which would clobber anything
 * the hooks tried to stash. So this class declares no fields and the hooks read only
 * `this.oaiRealtimeModel` and `this._options`, both of which the base constructor assigns before
 * either hook fires.
 */
export class RealtimeSession extends OpenAIRealtimeSession {
  /** The Inworld model this session was created from. */
  private get inworldModel(): RealtimeModel {
    return this.oaiRealtimeModel as RealtimeModel;
  }

  protected override async createWsConn(): Promise<WebSocket> {
    const apiKey = this._options.apiKey;
    if (!apiKey) {
      throw new Error(
        'Inworld API key is required but not set. Check the INWORLD_API_KEY environment variable.',
      );
    }

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      // Inworld API keys are already base64-encoded, so they are passed through as-is with the
      // `Basic` scheme rather than `Bearer`.
      Authorization: `Basic ${apiKey}`,
    };

    const url = buildWsUrl(this._options.baseURL);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      let waiting = true;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, this._options.connOptions.timeoutMs);

      ws.once('open', () => {
        if (!waiting) return;
        waiting = false;
        clearTimeout(timeout);
        resolve(ws);
      });

      ws.once('close', () => {
        if (!waiting) return;
        waiting = false;
        clearTimeout(timeout);
        reject(new Error('Inworld Realtime API connection closed'));
      });
    });
  }

  protected override createSessionUpdateEvent(): realtime.SessionUpdateEvent {
    const event = super.createSessionUpdateEvent();
    const session = event.session as InworldSessionUpdate;

    if (session.audio?.output) {
      session.audio.output.model = this.inworldModel._ttsModel;
    }
    session.providerData = this.inworldModel._providerData;

    return event;
  }
}
