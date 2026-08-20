// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Future, llm, log, type metrics, shortuuid } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-openai';
import type { ReadableStream } from 'node:stream/web';

const {
  DiscardedGeneration,
  RealtimeModel: OpenAIRealtimeModel,
  RealtimeSession: OpenAIRealtimeSession,
} = realtime;
type OpenAIRealtimeModelOptions = ConstructorParameters<typeof OpenAIRealtimeModel>[0];

const XAI_BASE_URL = 'wss://api.x.ai/v1';
// Ref: python livekit-plugins/livekit-plugins-xai/livekit/plugins/xai/realtime/realtime_model.py - 32 lines
const DEFAULT_MODEL: GrokRealtimeModels = 'grok-voice-latest';
const DEFAULT_VOICE = 'ara';
const XAI_DEFAULT_INPUT_AUDIO_TRANSCRIPTION = { model: 'grok-transcribe' };

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
  | 'grok-voice-latest'
  | 'grok-voice-think-fast-2.0'
  | 'grok-voice-think-fast-1.0'
  | 'grok-voice-fast-1.0';

export type RealtimeModelOptions = Omit<NonNullable<OpenAIRealtimeModelOptions>, 'model'> & {
  model?: GrokRealtimeModels | string;
  voice?: GrokVoices | string;
  apiKey?: string;
};

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
      inputAudioTranscription: XAI_DEFAULT_INPUT_AUDIO_TRANSCRIPTION,
      turnDetection: XAI_DEFAULT_TURN_DETECTION,
      ...options,
    });
    this.capabilities.perResponseToolChoice = false;
    this.capabilities.supportsSay = true;
  }

  override session(): RealtimeSession {
    return new RealtimeSession(this);
  }
}

export class RealtimeSession extends OpenAIRealtimeSession {
  private pendingTranscription?: realtime.ConversationItemInputAudioTranscriptionCompletedEvent;
  private responseSpoke = false;
  private pendingSayEventIds: string[] = [];
  private staleSayTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sayAbortControllers = new Set<AbortController>();
  private sessionConnectedAt = 0;

  constructor(realtimeModel: RealtimeModel) {
    super(realtimeModel);
    this.on('openai_server_event_received', this.onXaiServerEvent);
  }

  protected override resetInputTurnState(): void {
    this.flushInputTranscription();
    super.resetInputTurnState();
    this.responseSpoke = false;
  }

  override async close(): Promise<void> {
    for (const controller of this.sayAbortControllers) controller.abort();
    this.flushInputTranscription();
    for (const timer of this.staleSayTimers.values()) clearTimeout(timer);
    this.staleSayTimers.clear();
    if (this.sessionConnectedAt > 0) {
      const realtimeModel = this.realtimeModel;
      this.emit('metrics_collected', {
        type: 'realtime_model_metrics',
        label: realtimeModel.label(),
        requestId: 'session_close',
        timestamp: Date.now(),
        durationMs: 0,
        sessionDurationMs: Date.now() - this.sessionConnectedAt,
        ttftMs: -1,
        cancelled: false,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        tokensPerSecond: 0,
        inputTokenDetails: {
          audioTokens: 0,
          textTokens: 0,
          imageTokens: 0,
          cachedTokens: 0,
        },
        outputTokenDetails: { audioTokens: 0, textTokens: 0, imageTokens: 0 },
        metadata: { modelName: realtimeModel.model, modelProvider: realtimeModel.provider },
      } satisfies metrics.RealtimeModelMetrics);
    }
    await super.close();
  }

  private onXaiServerEvent = (event: Record<string, unknown>): void => {
    if (event.type === 'conversation.item.input_audio_transcription.updated') {
      const itemId = typeof event.item_id === 'string' ? event.item_id : '';
      const transcript = typeof event.transcript === 'string' ? event.transcript : '';
      if (itemId && transcript) {
        this.emit('input_audio_transcription_completed', {
          itemId,
          transcript,
          isFinal: false,
        } satisfies llm.InputTranscriptionCompleted);
      }
    } else if (event.type === 'input_audio_buffer.timeout_triggered') {
      log().debug('xAI idle timeout triggered; server will start a proactive turn');
    } else if (event.type === 'session.created') {
      this.sessionConnectedAt = Date.now();
      const session = event.session as Record<string, unknown> | undefined;
      log().debug({ model: session?.model }, 'xAI session created');
    }
  };

  protected override createSessionUpdateEvent(): realtime.SessionUpdateEvent {
    const event = super.createSessionUpdateEvent();
    const audio = event.session.audio;
    if (audio?.output?.voice !== undefined) {
      event.session.voice = audio.output.voice;
      delete audio.output.voice;
    }
    if (audio?.input?.turn_detection !== undefined) {
      event.session.turn_detection = audio.input.turn_detection;
      delete audio.input.turn_detection;
    }
    if (this._options.reasoning) {
      event.session.reasoning = this._options.reasoning;
    }
    return event;
  }

  override async say(
    text: string | ReadableStream<string>,
    options: { signal?: AbortSignal } = {},
  ): Promise<llm.GenerationCreatedEvent> {
    const eventId = shortuuid('say_');
    const doneFut = new Future<llm.GenerationCreatedEvent>();
    const handle = { doneFut };
    this.responseCreatedFutures[eventId] = handle;

    const abortController = new AbortController();
    this.sayAbortControllers.add(abortController);
    const forwardAbort = () => abortController.abort();
    if (options.signal?.aborted) abortController.abort();
    else options.signal?.addEventListener('abort', forwardAbort, { once: true });

    let forceMessageSent = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (doneFut.done) return;
      delete this.responseCreatedFutures[eventId];
      if (forceMessageSent) this.discardSay(eventId);
      doneFut.reject(new Error('say aborted'));
    };
    if (abortController.signal.aborted) onAbort();
    else abortController.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const fullText =
        typeof text === 'string' ? text : await this.readText(text, abortController.signal);
      if (doneFut.done) return await doneFut.await;

      this.sendEvent({
        type: 'conversation.item.create',
        event_id: eventId,
        item: {
          type: 'force_message',
          role: 'assistant',
          content: [{ type: 'output_text', text: fullText }],
        },
      });
      forceMessageSent = true;
      this.ensurePendingSayTag(eventId);

      timeout = setTimeout(() => {
        if (this.responseCreatedFutures[eventId] === handle) {
          delete this.responseCreatedFutures[eventId];
          this.discardedEventIds.add(eventId);
          this.ensurePendingSayTag(eventId);
          this.scheduleStaleSayCleanup(eventId);
          if (!doneFut.done) doneFut.reject(new Error('say timed out.'));
        }
      }, 10000);
      const generation = await doneFut.await;
      this.dropPendingSayTag(eventId);
      return generation;
    } catch (error) {
      delete this.responseCreatedFutures[eventId];
      if (!forceMessageSent) this.dropPendingSayTag(eventId);
      if (doneFut.done) return await doneFut.await;
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      abortController.signal.removeEventListener('abort', onAbort);
      options.signal?.removeEventListener('abort', forwardAbort);
      this.sayAbortControllers.delete(abortController);
    }
  }

  private async readText(text: ReadableStream<string>, signal?: AbortSignal): Promise<string> {
    const reader = text.getReader();
    const cancelRead = () => void reader.cancel(new Error('say aborted')).catch(() => undefined);
    signal?.addEventListener('abort', cancelRead, { once: true });
    let fullText = '';
    try {
      while (true) {
        if (signal?.aborted) throw new Error('say aborted');
        const { done, value } = await reader.read();
        if (signal?.aborted) throw new Error('say aborted');
        if (done) return fullText;
        fullText += value;
      }
    } finally {
      signal?.removeEventListener('abort', cancelRead);
      reader.releaseLock();
    }
  }

  private ensurePendingSayTag(eventId: string): void {
    if (!this.pendingSayEventIds.includes(eventId)) this.pendingSayEventIds.push(eventId);
  }

  private dropPendingSayTag(eventId: string): void {
    const index = this.pendingSayEventIds.indexOf(eventId);
    if (index !== -1) this.pendingSayEventIds.splice(index, 1);
  }

  private discardSay(eventId: string): void {
    delete this.responseCreatedFutures[eventId];
    if (!this.discardedEventIds.has(eventId)) {
      this.sendEvent({ type: 'response.cancel' });
      this.discardedEventIds.add(eventId);
      this.scheduleStaleSayCleanup(eventId);
    }
    this.ensurePendingSayTag(eventId);
  }

  private scheduleStaleSayCleanup(eventId: string): void {
    if (this.staleSayTimers.has(eventId)) return;
    this.staleSayTimers.set(
      eventId,
      setTimeout(() => {
        this.staleSayTimers.delete(eventId);
        if (this.discardedEventIds.has(eventId)) {
          this.dropPendingSayTag(eventId);
          this.discardedEventIds.delete(eventId);
        }
      }, 10000),
    );
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
    if (this.pendingSayEventIds.length > 0 && !event.response.metadata?.client_event_id) {
      event.response.metadata = {
        ...event.response.metadata,
        client_event_id: this.pendingSayEventIds.shift()!,
      };
    }
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
