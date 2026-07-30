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
const DEFAULT_LLM_MODEL = 'google-ai-studio/gemini-3.1-flash-lite';
const DEFAULT_TTS_MODEL = 'inworld-tts-2';
const DEFAULT_STT_MODEL = 'inworld/inworld-stt-1';
const DEFAULT_VOICE = 'Ashley';

const USER_AGENT = 'LiveKit Agents';

/** Inworld adds `model` on `session.audio.output`; OpenAI's type does not. */
type InworldAudioConfigOutput = realtime.RealtimeAudioConfigOutput & { model?: string };

/** Inworld adds `providerData` on `session.update`; OpenAI's type does not. */
type InworldSessionUpdate = realtime.SessionUpdateEvent['session'] & {
  providerData?: ProviderData;
  audio?: realtime.SessionUpdateEvent['session']['audio'] & {
    output?: InworldAudioConfigOutput;
  };
};

export interface RealtimeModelOptions
  extends Omit<OpenAIRealtimeModelOptions, 'model' | 'baseURL' | 'azureDeployment' | 'apiVersion'> {
  /** LLM in `provider/model` form. @defaultValue `'google-ai-studio/gemini-3.1-flash-lite'` */
  model?: string;
  /** TTS model for audio output. @defaultValue `'inworld-tts-2'` */
  ttsModel?: string;
  /**
   * STT model in `provider/model` form. Ignored when `inputAudioTranscription` is set.
   *
   * @defaultValue `'inworld/inworld-stt-1'`
   */
  sttModel?: string;
  /** @defaultValue `'Ashley'` */
  voice?: string;
  /** Falls back to `$INWORLD_API_KEY`. Already base64-encoded; sent as HTTP Basic. */
  apiKey?: string;
  /**
   * Realtime WebSocket endpoint. `http(s)://` is rewritten to `ws(s)://`.
   *
   * @defaultValue `'wss://api.inworld.ai/api/v1/realtime/session'`
   */
  baseURL?: string;
  providerData?: ProviderData;
}

/**
 * Build the Inworld Realtime WebSocket URL.
 *
 * Unlike OpenAI's `processBaseURL`, this does not append `/realtime` or `?model=`.
 *
 * @internal
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
 * Inworld Realtime model. Subclasses the OpenAI Realtime plugin; overrides auth, URL shape, and
 * Inworld-specific fields on the initial `session.update`.
 */
export class RealtimeModel extends OpenAIRealtimeModel {
  /** @internal */
  _ttsModel: string;
  /** @internal */
  _providerData: ProviderData;

  override label(): string {
    return 'inworld.RealtimeModel';
  }

  /** Fixed to `'Inworld'`; the base class would derive this from the URL host. */
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

    this._ttsModel = options.ttsModel ?? DEFAULT_TTS_MODEL;
    this._providerData = {
      auto_tool_response: false,
      ...options.providerData,
      caching: { enabled: true, ...options.providerData?.caching },
    };
  }

  override session(): RealtimeSession {
    return new RealtimeSession(this);
  }
}

/**
 * Inworld Realtime session.
 *
 * Declares no instance fields: `createWsConn` / `createSessionUpdateEvent` run inside the base
 * constructor, and with `useDefineForClassFields` any subclass field would be reset to `undefined`
 * after `super()`. Read model state via `oaiRealtimeModel` / `_options` instead.
 */
export class RealtimeSession extends OpenAIRealtimeSession {
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

    // Inworld keys are already base64-encoded; use Basic (not Bearer).
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
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
