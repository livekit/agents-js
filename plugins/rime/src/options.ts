// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { tokenize } from '@livekit/agents';
import { log } from '@livekit/agents';
import { isIP } from 'node:net';
import type { DefaultLanguages, TTSModels } from './models.js';

export type WebSocketProtocol = 'binary' | 'json';
export type RimeAudioFormat =
  | 'audio/pcm'
  | 'audio/pcmu'
  | 'audio/wav'
  | 'audio/mpeg'
  | 'audio/ogg;codecs=opus'
  | 'audio/webm;codecs=opus';

const RIME_BASE_URL = 'https://users.rime.ai/v1/rime-tts';
const RIME_WS_BASE_URL = 'wss://users-ws.rime.ai';
const RIME_TTS_SAMPLE_RATE = 24000;

/**
 * Get the appropriate sample rate based on TTS options.
 *
 * @param opts - Optional TTS configuration options
 * @returns The sample rate in Hz. Returns the explicit samplingRate if provided,
 *          otherwise returns model-specific defaults (24000 for coda, 22050 for mistv2,
 *          or the default RIME_TTS_SAMPLE_RATE for other models)
 */
export function getSampleRate(opts?: Partial<TTSOptions>): number {
  if (opts?.samplingRate !== undefined) {
    return opts.samplingRate;
  }
  switch (opts?.modelId) {
    case 'coda':
      return 24000;
    case 'mistv2':
      return 22050;
    default:
      return RIME_TTS_SAMPLE_RATE;
  }
}

export function endpointIdentity(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname.toLowerCase().replace(/\.$/, '')}:${url.port || (url.protocol === 'wss:' ? 443 : 80)}${url.pathname.replace(/\/+$/, '')}`;
}

export function validateEndpoint(value: string, allowCustom = false, websocket = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Rime endpoint must be an absolute URL');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = (isIP(host) === 4 && host.startsWith('127.')) || host === '[::1]';
  if (url.username || url.password || url.hash)
    throw new Error('Rime endpoint cannot contain user information or a fragment');
  if (websocket && !['ws:', 'wss:'].includes(url.protocol))
    throw new Error('Rime websocketURL must use ws or wss');
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol))
    throw new Error('Unsupported Rime endpoint scheme');
  if (['http:', 'ws:'].includes(url.protocol) && !loopback)
    throw new Error('Rime endpoint must use a secure connection except on loopback IPs');
  if (!allowCustom && !loopback && host !== 'rime.ai' && !host.endsWith('.rime.ai')) {
    throw new Error(
      'Rime endpoint must use a trusted Rime host; set allowCustomEndpoint to send credentials to another host',
    );
  }
  return url;
}

export function resolveOptions(opts: Partial<TTSOptions>, previous?: TTSOptions): TTSOptions {
  const v1 = previous?.websocketURL !== undefined || opts.websocketURL !== undefined;
  let model = opts.modelId ?? previous?.modelId ?? 'coda';
  if (v1) {
    if (previous && !previous.websocketURL)
      throw new Error('websocketURL requires a TTS constructed with websocketURL');
    if (opts.baseURL !== undefined || opts.useWebsocket !== undefined)
      throw new Error('websocketURL selects streaming; omit baseURL and useWebsocket');
    for (const key of [
      'speedAlpha',
      'repetition_penalty',
      'temperature',
      'top_p',
      'max_tokens',
      'reduceLatency',
      'segment',
      'inlineSpeedAlpha',
      'noTextNormalization',
      'saveOovs',
    ]) {
      if (opts[key] !== undefined) throw new Error(`${key} is not supported by Rime WebSocket v1`);
    }
    if (previous && opts.modelId !== undefined && opts.websocketURL === undefined)
      throw new Error('Update modelId together with websocketURL');
    const url = validateEndpoint(
      opts.websocketURL ?? previous!.websocketURL!,
      opts.allowCustomEndpoint ?? previous?.allowCustomEndpoint,
      true,
    );
    const parts = url.pathname.replace(/\/+$/, '').split('/');
    if (parts.pop() !== 'ws') throw new Error('Rime websocketURL path must end with /ws');
    const pathModel = parts.pop();
    if (pathModel) {
      if (opts.modelId !== undefined)
        throw new Error('modelId is derived from websocketURL; omit modelId');
      try {
        model = decodeURIComponent(pathModel);
      } catch {
        throw new Error('Invalid Rime model path');
      }
      if (model === 'mist') model = 'mistv3';
    } else if (!opts.modelId && !previous)
      throw new Error('modelId is required for a dedicated /ws endpoint');
    if (
      previous &&
      model !== previous.modelId &&
      endpointIdentity(url.href) === endpointIdentity(previous.websocketURL!)
    )
      throw new Error('modelId cannot change without changing the model endpoint');
    if (
      !model.includes('mist') &&
      (opts.pauseBetweenBrackets !== undefined || opts.phonemizeBetweenBrackets !== undefined)
    )
      throw new Error('Mist options require a Mist model');
  } else if (opts.audioFormat !== undefined || opts.websocketProtocol !== undefined) {
    throw new Error('audioFormat and websocketProtocol require websocketURL');
  }
  if (previous && Boolean(previous.websocketURL) !== v1)
    throw new Error('Cannot change Rime transport');
  if (opts.timeScaleFactor !== undefined && model === 'mistv2')
    throw new Error('timeScaleFactor is not supported by mistv2');
  const useWebsocket =
    v1 ||
    Boolean(opts.useWebsocket ?? previous?.useWebsocket) ||
    Boolean(opts.baseURL?.startsWith('ws'));
  if (previous && previous.useWebsocket !== useWebsocket)
    throw new Error('Cannot change Rime transport');
  const resolved: TTSOptions = {
    ...defaultTTSOptions,
    ...previous,
    ...opts,
    websocketURL: opts.websocketURL ?? previous?.websocketURL,
    modelId: model,
    useWebsocket,
    apiKey: opts.apiKey ?? previous?.apiKey ?? process.env.RIME_API_KEY,
    baseURL:
      opts.baseURL ?? previous?.baseURL ?? (useWebsocket && !v1 ? RIME_WS_BASE_URL : RIME_BASE_URL),
  };
  if (!previous && opts.speaker === undefined) {
    resolved.speaker = v1
      ? model.includes('mist')
        ? 'cove'
        : 'astra'
      : opts.modelId === 'coda'
        ? 'lyra'
        : 'luna';
  }
  if (v1) {
    resolved.websocketProtocol ??= 'binary';
    resolved.audioFormat ??= 'audio/pcm';
    resolved.lang ??= 'eng';
    if (!['binary', 'json'].includes(resolved.websocketProtocol))
      throw new Error('websocketProtocol must be binary or json');
    if (
      ![
        'audio/pcm',
        'audio/pcmu',
        'audio/wav',
        'audio/mpeg',
        'audio/ogg;codecs=opus',
        'audio/webm;codecs=opus',
      ].includes(resolved.audioFormat)
    )
      throw new Error('Unsupported Rime audioFormat');
    if (!resolved.lang) throw new Error('Rime v1 requires a language');
  } else validateEndpoint(resolved.baseURL!, resolved.allowCustomEndpoint, useWebsocket);
  if (!Number.isInteger(getSampleRate(resolved)) || getSampleRate(resolved) <= 0)
    throw new Error('samplingRate must be a positive integer');
  if (!resolved.apiKey)
    throw new Error('RIME API key is required, whether as an argument or as $RIME_API_KEY');
  return resolved;
}

/** Configuration options for Rime AI TTS */
export interface TTSOptions {
  /** Explicit endpoint selects the Rime v1 streaming protocol. */
  websocketURL?: string;
  websocketProtocol?: WebSocketProtocol;
  audioFormat?: RimeAudioFormat;
  /** Allow sending the API key to a host outside rime.ai. */
  allowCustomEndpoint?: boolean;
  speaker: string;
  modelId: TTSModels | string;
  baseURL?: string;
  apiKey?: string;
  useWebsocket?: boolean;
  segment?: string;
  tokenizer?: tokenize.SentenceTokenizer;
  lang?: DefaultLanguages | string;
  repetition_penalty?: number;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  samplingRate?: number;
  timeScaleFactor?: number;
  speedAlpha?: number;
  reduceLatency?: boolean;
  pauseBetweenBrackets?: boolean;
  phonemizeBetweenBrackets?: boolean;
  inlineSpeedAlpha?: string;
  noTextNormalization?: boolean;
  saveOovs?: boolean;
  /** Additional Rime API parameters */
  [key: string]: string | number | boolean | tokenize.SentenceTokenizer | undefined;
}

const defaultTTSOptions: TTSOptions = {
  modelId: 'coda',
  speaker: 'luna',
  apiKey: process.env.RIME_API_KEY,
  baseURL: RIME_BASE_URL,
  useWebsocket: false,
  segment: 'bySentence',
};

export function warnIfArcana(modelId: TTSOptions['modelId'] | undefined): void {
  if (modelId === 'arcana') {
    log().warn("Rime Arcana is no longer supported. Use modelId: 'coda' instead.");
  }
}

function modelParams(opts: TTSOptions): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  if (opts.lang !== undefined) params.lang = opts.lang;

  if (opts.modelId === 'coda') {
    if (opts.repetition_penalty !== undefined) params.repetition_penalty = opts.repetition_penalty;
    if (opts.temperature !== undefined) params.temperature = opts.temperature;
    if (opts.top_p !== undefined) params.top_p = opts.top_p;
    if (opts.max_tokens !== undefined) params.max_tokens = opts.max_tokens;
    if (opts.timeScaleFactor !== undefined) params.timeScaleFactor = opts.timeScaleFactor;
  } else if (opts.modelId.includes('mist')) {
    if (opts.speedAlpha !== undefined) params.speedAlpha = opts.speedAlpha;
    if (opts.pauseBetweenBrackets !== undefined) {
      params.pauseBetweenBrackets = opts.pauseBetweenBrackets;
    }
    if (opts.phonemizeBetweenBrackets !== undefined) {
      params.phonemizeBetweenBrackets = opts.phonemizeBetweenBrackets;
    }
    if (opts.modelId !== 'mistv2' && opts.timeScaleFactor !== undefined) {
      params.timeScaleFactor = opts.timeScaleFactor;
    }
  }

  return params;
}

export function fetchPayload(opts: TTSOptions, text: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    speaker: opts.speaker,
    text,
    modelId: opts.modelId,
    ...modelParams(opts),
  };

  payload.samplingRate = getSampleRate(opts);
  if (opts.modelId === 'mistv2' && opts.reduceLatency !== undefined) {
    payload.reduceLatency = opts.reduceLatency;
  }

  for (const [key, value] of Object.entries(opts)) {
    if (
      value === undefined ||
      [
        'websocketURL',
        'websocketProtocol',
        'audioFormat',
        'allowCustomEndpoint',
        'apiKey',
        'baseURL',
        'useWebsocket',
        'segment',
        'tokenizer',
        'speaker',
        'modelId',
        'lang',
        'repetition_penalty',
        'temperature',
        'top_p',
        'max_tokens',
        'samplingRate',
        'timeScaleFactor',
        'speedAlpha',
        'pauseBetweenBrackets',
        'phonemizeBetweenBrackets',
        'reduceLatency',
      ].includes(key)
    ) {
      continue;
    }
    payload[key] = value;
  }

  return payload;
}

export function wsUrl(opts: TTSOptions): string {
  const params = new URLSearchParams();
  const sampleRate = getSampleRate(opts);
  const query: Record<string, string | number | boolean> = {
    speaker: opts.speaker,
    modelId: opts.modelId,
    audioFormat: 'pcm',
    samplingRate: sampleRate,
    segment: opts.segment ?? 'bySentence',
    ...modelParams(opts),
  };

  for (const [key, value] of Object.entries(query)) {
    params.set(key, typeof value === 'boolean' ? String(value) : `${value}`);
  }

  return `${opts.baseURL}/ws3?${params.toString()}`;
}
