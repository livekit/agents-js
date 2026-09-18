// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as apiProto from '../llm/openai_realtime/api_proto.js';
import {
  RealtimeModel as OpenAIRealtimeModel,
  RealtimeSession as OpenAIRealtimeSession,
  processBaseURL,
} from '../llm/openai_realtime/realtime_model.js';
import type { ToolChoice, ToolContext } from '../llm/tool_context.js';
import type { APIConnectOptions } from '../types.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import {
  INFERENCE_PROVIDER_HEADER,
  type InferenceClass,
  connectWs,
  createAccessToken,
  getDefaultInferenceUrl,
  resolveCredentials,
} from './utils.js';

const XAI_DEFAULT_INPUT_AUDIO_TRANSCRIPTION: apiProto.InputAudioTranscription = {
  model: 'grok-transcribe',
};
const XAI_DEFAULT_TURN_DETECTION: apiProto.TurnDetectionType = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 200,
  create_response: true,
  interrupt_response: true,
};

export interface RealtimeModelOptions {
  model: string;
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  apiSecret?: string;
  inferenceClass?: InferenceClass;
  voice?: string;
  modalities?: apiProto.Modality[];
  inputAudioTranscription?: apiProto.InputAudioTranscription | null;
  inputAudioNoiseReduction?: apiProto.NoiseReduction | null;
  turnDetection?: apiProto.TurnDetectionType | null;
  toolChoice?: ToolChoice;
  speed?: number;
  tracing?: apiProto.TracingConfig | null;
  reasoning?: apiProto.Reasoning;
  maxSessionDuration?: number | null;
  connOptions?: APIConnectOptions;
}

interface InferenceOptions {
  provider?: string;
  apiKey: string;
  apiSecret: string;
  inferenceClass?: InferenceClass;
}

/** OpenAI-compatible realtime model authenticated through LiveKit Inference. */
export class RealtimeModel extends OpenAIRealtimeModel {
  /** @internal */
  readonly _inferenceOptions: InferenceOptions;

  override get provider(): string {
    return 'livekit';
  }

  override label(): string {
    return 'inference.RealtimeModel';
  }

  constructor(options: RealtimeModelOptions) {
    if (!options.model.includes('/')) {
      throw new Error("model must be provider-prefixed, for example 'openai/gpt-realtime'");
    }

    const credentials = resolveCredentials(options.apiKey, options.apiSecret);
    const isXAI = options.model.startsWith('xai/');
    const turnDetectionWasDefaulted = options.turnDetection === undefined;

    super({
      model: options.model,
      baseURL: options.baseURL || getDefaultInferenceUrl(),
      apiKey: 'livekit-inference',
      ...(options.voice !== undefined ? { voice: options.voice } : isXAI ? { voice: 'eve' } : {}),
      ...(options.modalities !== undefined ? { modalities: options.modalities } : {}),
      ...(options.inputAudioTranscription !== undefined
        ? { inputAudioTranscription: options.inputAudioTranscription }
        : isXAI
          ? { inputAudioTranscription: XAI_DEFAULT_INPUT_AUDIO_TRANSCRIPTION }
          : {}),
      ...(options.inputAudioNoiseReduction !== undefined
        ? { inputAudioNoiseReduction: options.inputAudioNoiseReduction }
        : {}),
      ...(options.turnDetection !== undefined
        ? { turnDetection: options.turnDetection }
        : isXAI
          ? { turnDetection: XAI_DEFAULT_TURN_DETECTION }
          : {}),
      ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
      ...(options.speed !== undefined ? { speed: options.speed } : {}),
      ...(options.tracing !== undefined ? { tracing: options.tracing } : {}),
      ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
      ...(options.maxSessionDuration !== undefined
        ? { maxSessionDuration: options.maxSessionDuration }
        : {}),
      connOptions: options.connOptions || DEFAULT_API_CONNECT_OPTIONS,
    });

    if (isXAI) {
      this.capabilities.canDisableTurnDetection = turnDetectionWasDefaulted;
    }
    this._inferenceOptions = {
      provider: options.provider,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      inferenceClass: options.inferenceClass,
    };
  }

  override session(options?: { turnDetectionDisabled?: boolean }): RealtimeSession {
    return new RealtimeSession(this, options);
  }
}

export class RealtimeSession extends OpenAIRealtimeSession {
  constructor(realtimeModel: RealtimeModel, options?: { turnDetectionDisabled?: boolean }) {
    super(realtimeModel, options);
  }

  protected override createSessionUpdateEvent(): apiProto.SessionUpdateEvent {
    const event = super.createSessionUpdateEvent();
    delete event.session.model;
    return event;
  }

  protected override createToolsUpdateEvent(tools: ToolContext) {
    const event = super.createToolsUpdateEvent(tools);
    delete event.session.model;
    return event;
  }

  protected override async createWsConn() {
    const model = this.realtimeModel as RealtimeModel;
    const options = model._inferenceOptions;
    const headers: Record<string, string> = {};
    headers.Authorization = `Bearer ${await createAccessToken(options.apiKey, options.apiSecret)}`;
    if (options.provider) {
      headers[INFERENCE_PROVIDER_HEADER] = options.provider;
    }

    return connectWs(
      processBaseURL({
        baseURL: model._options.baseURL,
        model: model.model,
        isAzure: false,
      }),
      headers,
      model._options.connOptions.timeoutMs,
      options.inferenceClass,
    );
  }

  protected override isFatalError(error: unknown): boolean {
    if (error !== null && typeof error === 'object') {
      const { code, type } = error as { code?: unknown; type?: unknown };
      const errorCode = typeof code === 'string' && code.length > 0 ? code : type;
      if (
        typeof errorCode === 'string' &&
        [
          'unsupported_transcription_model',
          'unsupported_audio_transport',
          'unsupported_audio_format',
        ].includes(errorCode)
      ) {
        return true;
      }
    }
    return super.isFatalError(error);
  }
}
