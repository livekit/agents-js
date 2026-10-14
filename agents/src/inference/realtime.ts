// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import * as llm from '../llm/index.js';
import type * as apiProto from '../llm/openai_realtime/api_proto.js';
import {
  DiscardedGeneration,
  RealtimeModel as OpenAIRealtimeModel,
  RealtimeSession as OpenAIRealtimeSession,
  processBaseURL,
} from '../llm/openai_realtime/realtime_model.js';
import type { ToolChoice, ToolContext } from '../llm/tool_context.js';
import { log } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { type OpenAIGPTLiveModels, isGPTLiveModel } from './gpt_live.js';
import {
  INFERENCE_PROVIDER_HEADER,
  type InferenceClass,
  connectWs,
  createAccessToken,
  getDefaultInferenceUrl,
  resolveCredentials,
} from './utils.js';

export type OpenAIRealtimeModels =
  | 'openai/gpt-realtime'
  | 'openai/gpt-realtime-mini'
  | 'openai/gpt-realtime-2.1'
  | 'openai/gpt-realtime-2.1-mini';

export type GoogleRealtimeModels =
  | 'google/gemini-3.8-live'
  | 'google/gemini-3.8-live-extended-thinking'
  | 'google/gemini-live';

export type XAIRealtimeModels = 'xai/grok-voice' | 'xai/grok-voice-latest' | 'xai/grok-voice-3.0';

export type RealtimeModels =
  | OpenAIRealtimeModels
  | OpenAIGPTLiveModels
  | GoogleRealtimeModels
  | XAIRealtimeModels;

const REALTIME_MODEL_IDS: ReadonlySet<string> = new Set<RealtimeModels>([
  'openai/gpt-realtime',
  'openai/gpt-realtime-mini',
  'openai/gpt-realtime-2.1',
  'openai/gpt-realtime-2.1-mini',
  'openai/gpt-live-1',
  'google/gemini-3.8-live',
  'google/gemini-3.8-live-extended-thinking',
  'google/gemini-live',
  'xai/grok-voice',
  'xai/grok-voice-latest',
  'xai/grok-voice-3.0',
]);

/** Whether a LiveKit Inference model string names a realtime (speech-to-speech) model. */
export function isRealtimeModel(model: string): model is RealtimeModels {
  return REALTIME_MODEL_IDS.has(model);
}

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
  /**
   * Host that must serve the model, e.g. `'azure'` or `'openai'` for OpenAI models. The
   * session is refused if no host in the region matches.
   */
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  apiSecret?: string;
  /** Has no effect on realtime sessions. */
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
  isXAI: boolean;
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
    if (isGPTLiveModel(options.model)) {
      throw new Error(`${options.model} speaks the GPT-Live protocol; use inference.GPTLiveModel`);
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
      isXAI,
    };
  }

  static fromModelString(model: string): RealtimeModel {
    return new RealtimeModel({ model });
  }

  override session(options?: { turnDetectionDisabled?: boolean }): RealtimeSession {
    return new RealtimeSession(this, options);
  }
}

export class RealtimeSession extends OpenAIRealtimeSession {
  private readonly isXAI: boolean;
  private pendingTranscription?: apiProto.ConversationItemInputAudioTranscriptionCompletedEvent;
  private responseSpoke = false;

  constructor(realtimeModel: RealtimeModel, options?: { turnDetectionDisabled?: boolean }) {
    super(realtimeModel, options);
    this.isXAI = realtimeModel._inferenceOptions.isXAI;
  }

  protected override resetInputTurnState(): void {
    if (this.isXAI) {
      this.flushInputTranscription();
    }
    super.resetInputTurnState();
    this.responseSpoke = false;
  }

  override async close(): Promise<void> {
    if (this.isXAI) {
      this.flushInputTranscription();
    }
    await super.close();
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

  protected override async createChatCtxUpdateEvents(
    chatCtx: llm.ChatContext,
    addMockAudio: boolean = false,
  ): Promise<(apiProto.ConversationItemCreateEvent | apiProto.ConversationItemDeleteEvent)[]> {
    const pending = this.isXAI ? this.pendingTranscription : undefined;
    const node = pending ? this.remoteChatCtx.get(pending.item_id) : null;
    if (node && !chatCtx.getById(node.item.id)) {
      chatCtx = chatCtx.copy();
      let index = 0;
      let previous = node._prev;
      while (previous) {
        const previousIndex = chatCtx.indexById(previous.item.id);
        if (previousIndex !== undefined) {
          index = previousIndex + 1;
          break;
        }
        previous = previous._prev;
      }
      chatCtx.items.splice(index, 0, node.item);
    }

    return super.createChatCtxUpdateEvents(chatCtx, addMockAudio);
  }

  private discardAbandonedResponse(): void {
    if (
      !this.currentGeneration ||
      this.responseSpoke ||
      this.currentGeneration instanceof DiscardedGeneration
    ) {
      return;
    }

    log().debug('discarding the response xAI left in flight');
    this.closeCurrentGeneration();
    this.currentGeneration = new DiscardedGeneration();
  }

  override async interrupt(): Promise<void> {
    await super.interrupt();
    if (this.isXAI) {
      this.discardAbandonedResponse();
    }
  }

  protected override handleResponseCreated(event: apiProto.ResponseCreatedEvent): void {
    if (this.isXAI) {
      this.discardAbandonedResponse();
      this.closeCurrentGeneration();
      this.responseSpoke = false;
    }
    super.handleResponseCreated(event);
  }

  protected override handleInputAudioBufferSpeechStarted(
    event: apiProto.InputAudioBufferSpeechStartedEvent,
  ): void {
    if (
      this.isXAI &&
      this.pendingTranscription &&
      this.pendingTranscription.item_id !== event.item_id
    ) {
      this.flushInputTranscription();
    }
    super.handleInputAudioBufferSpeechStarted(event);
  }

  protected override handleConversationItemCreated(
    event: apiProto.ConversationItemCreatedEvent,
  ): void {
    if (!this.isXAI) {
      super.handleConversationItemCreated(event);
      return;
    }

    let previousItemId = event.previous_item_id;
    if (previousItemId && !this.remoteChatCtx.get(previousItemId)) {
      log().warn(
        { itemId: event.item.id, previousItemId },
        'xAI anchored an item to one it never announced, appending it instead',
      );
      previousItemId = '';
    }

    if (!previousItemId) {
      previousItemId = this.remoteChatCtx.toChatCtx().items.at(-1)?.id ?? '';
    }
    super.handleConversationItemCreated({ ...event, previous_item_id: previousItemId });
  }

  protected override handleConversationItemInputAudioTranscriptionCompleted(
    event: apiProto.ConversationItemInputAudioTranscriptionCompletedEvent,
  ): void {
    if (!this.isXAI) {
      super.handleConversationItemInputAudioTranscriptionCompleted(event);
      return;
    }

    if (event.status !== 'in_progress') {
      if (this.pendingTranscription && this.pendingTranscription.item_id !== event.item_id) {
        this.flushInputTranscription();
      }
      this.pendingTranscription = event;
    }

    this.emit('input_audio_transcription_completed', {
      itemId: event.item_id,
      transcript: event.transcript,
      isFinal: false,
    });
  }

  private flushInputTranscription(): void {
    const event = this.pendingTranscription;
    if (!event) return;
    this.pendingTranscription = undefined;

    const remoteItem = this.remoteChatCtx.get(event.item_id)?.item;
    if (remoteItem instanceof llm.ChatMessage) {
      remoteItem.content = remoteItem.content.filter((content) => typeof content !== 'string');
    }
    super.handleConversationItemInputAudioTranscriptionCompleted(event);
  }

  protected override handleResponseAudioDelta(event: apiProto.ResponseAudioDeltaEvent): void {
    if (this.isXAI) {
      this.responseSpoke = true;
      this.flushInputTranscription();
    }
    super.handleResponseAudioDelta(event);
  }

  protected override handleResponseTextDelta(event: apiProto.ResponseTextDeltaEvent): void {
    if (this.isXAI) {
      this.responseSpoke = true;
      this.flushInputTranscription();
    }
    super.handleResponseTextDelta(event);
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
