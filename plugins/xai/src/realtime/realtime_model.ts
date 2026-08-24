// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, log } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-openai';

const {
  DiscardedGeneration,
  RealtimeModel: OpenAIRealtimeModel,
  RealtimeSession: OpenAIRealtimeSession,
} = realtime;
type OpenAIRealtimeModelOptions = ConstructorParameters<typeof OpenAIRealtimeModel>[0];

const XAI_BASE_URL = 'wss://api.x.ai/v1';
// Ref: python livekit-plugins/livekit-plugins-xai/livekit/plugins/xai/realtime/realtime_model.py - 32 lines
const DEFAULT_MODEL: GrokRealtimeModels = 'grok-voice-think-fast-1.0';
const DEFAULT_VOICE = 'ara';

const XAI_DEFAULT_TURN_DETECTION = {
  type: 'server_vad' as const,
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 200,
  create_response: true,
  interrupt_response: true,
};

export type GrokVoices = 'eve' | 'ara' | 'rex' | 'sal' | 'leo';

// Ref: python livekit-plugins/livekit-plugins-xai/livekit/plugins/xai/types.py - 39-42 lines
export type GrokRealtimeModels =
  | 'grok-voice-fast-1.0'
  | 'grok-voice-think-fast-1.0'
  | 'grok-voice-think-fast-2.0';

export interface RealtimeModelOptions extends Omit<OpenAIRealtimeModelOptions, 'model'> {
  model?: GrokRealtimeModels | string;
  voice?: GrokVoices | string;
  apiKey?: string;
}

export class RealtimeModel extends OpenAIRealtimeModel {
  override label(): string {
    return 'xai.RealtimeModel';
  }

  constructor(options: RealtimeModelOptions = {}) {
    super({
      baseURL: XAI_BASE_URL,
      model: DEFAULT_MODEL,
      voice: options.voice || DEFAULT_VOICE,
      apiKey: options.apiKey || process.env.XAI_API_KEY,
      modalities: ['audio', 'text'],
      turnDetection: XAI_DEFAULT_TURN_DETECTION,
      ...options,
    });
  }

  override session(options?: llm.RealtimeSessionOptions): RealtimeSession {
    return new RealtimeSession(this, options);
  }
}

export class RealtimeSession extends OpenAIRealtimeSession {
  private pendingTranscription?: realtime.ConversationItemInputAudioTranscriptionCompletedEvent;
  private responseSpoke = false;

  protected override resetInputTurnState(): void {
    this.flushInputTranscription();
    super.resetInputTurnState();
    this.responseSpoke = false;
  }

  override async close(): Promise<void> {
    this.flushInputTranscription();
    await super.close();
  }

  protected override async createChatCtxUpdateEvents(
    chatCtx: llm.ChatContext,
    addMockAudio: boolean = false,
  ): Promise<(realtime.ConversationItemCreateEvent | realtime.ConversationItemDeleteEvent)[]> {
    const pending = this.pendingTranscription;
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
    this.discardAbandonedResponse();
  }

  protected override handleResponseCreated(event: realtime.ResponseCreatedEvent): void {
    this.discardAbandonedResponse();
    this.closeCurrentGeneration();
    this.responseSpoke = false;
    super.handleResponseCreated(event);
  }

  protected override handleInputAudioBufferSpeechStarted(
    event: realtime.InputAudioBufferSpeechStartedEvent,
  ): void {
    if (this.pendingTranscription && this.pendingTranscription.item_id !== event.item_id) {
      this.flushInputTranscription();
    }
    super.handleInputAudioBufferSpeechStarted(event);
  }

  protected override handleConversationItemCreated(
    event: realtime.ConversationItemCreatedEvent,
  ): void {
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
    event: realtime.ConversationItemInputAudioTranscriptionCompletedEvent,
  ): void {
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

  protected override handleResponseAudioDelta(event: realtime.ResponseAudioDeltaEvent): void {
    this.responseSpoke = true;
    this.flushInputTranscription();
    super.handleResponseAudioDelta(event);
  }

  protected override handleResponseTextDelta(event: realtime.ResponseTextDeltaEvent): void {
    this.responseSpoke = true;
    this.flushInputTranscription();
    super.handleResponseTextDelta(event);
  }
}
