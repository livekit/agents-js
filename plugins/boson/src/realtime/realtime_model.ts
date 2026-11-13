// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  log,
  shortuuid,
} from '@livekit/agents';
import type { metrics } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-openai';
import { WebSocket } from 'ws';
import {
  formatError,
  isRecord,
  livekitItemToBosonItem,
  mergeSessionValue,
  normalizeTranscription,
  normalizeWsUrl,
  sessionUpdate,
  setMessageText,
  textFromContent,
  toolChoiceToBoson,
  toolsToBoson,
  transcriptionEnabled,
} from './utils.js';

export const DEFAULT_URL = 'wss://api.boson.ai/v1/realtime';
const DEFAULT_MAX_SESSION_DURATION = 20 * 60 * 1000;
const NON_RETRYABLE_CLOSE_CODES = new Set([3000, 4429]);
const FATAL_ERROR_CODES = new Set([
  'insufficient_quota',
  'monthly_cap_reached',
  'contract_ended',
  'no_billing_account',
]);
const NONFATAL_ERROR_CODES = new Set(['response_not_active', 'response_id_mismatch']);
const NONFATAL_ERROR_TYPES = new Set(['voice_output_task_ongoing', 'invalid_previous_item_id']);

export const DEFAULT_TURN_DETECTION: realtime.TurnDetectionType = {
  type: 'server_vad',
  create_response: true,
  interrupt_response: true,
  prefix_padding_ms: 300,
  silence_duration_ms: 500,
  threshold: 0.55,
};

export interface RealtimeModelOptions {
  url?: string;
  apiKey?: string | null;
  model?: string;
  voice?: string;
  outputModalities?: realtime.Modality[];
  temperature?: number;
  maxOutputTokens?: number | 'inf';
  toolChoice?: llm.ToolChoice | null;
  speed?: number;
  turnDetection?: realtime.TurnDetectionType | null | false;
  inputAudioTranscription?: Record<string, unknown> | null;
  inputAudioTranscriptionModel?: string;
  inputAudioTranscriptionLanguage?: string;
  inputAudioNoiseReduction?: realtime.NoiseReduction | realtime.NoiseReductionType | null;
  truncation?: 'auto' | 'disabled';
  queryParams?: Record<string, string>;
  maxSessionDuration?: number | null;
  connOptions?: APIConnectOptions;
}

export interface RealtimeSessionOptionsUpdate {
  toolChoice?: llm.ToolChoice | null;
  voice?: string;
  speed?: number;
  turnDetection?: realtime.TurnDetectionType | null | false;
  inputAudioTranscription?: Record<string, unknown> | null;
  inputAudioNoiseReduction?: realtime.NoiseReduction | realtime.NoiseReductionType | null;
  maxResponseOutputTokens?: number | 'inf' | null;
  maxOutputTokens?: number | 'inf' | null;
  temperature?: number;
  truncation?: 'auto' | 'disabled' | null;
}

interface BosonOptions {
  url: string;
  apiKey: string | null;
  model: string;
  voice: string;
  temperature?: number;
  maxOutputTokens: number | 'inf';
  toolChoice: llm.ToolChoice | null;
  speed: number;
  turnDetection: Record<string, unknown> | null;
  inputAudioTranscription?: Record<string, unknown>;
  noiseReduction: Record<string, unknown> | null;
  outputModalities: realtime.Modality[];
  truncation: 'auto' | 'disabled';
}

function noiseReduction(
  value: RealtimeModelOptions['inputAudioNoiseReduction'],
): Record<string, unknown> | null {
  if (value == null) return null;
  return typeof value === 'string' ? { type: value } : { ...value };
}

function resolveModalities(modalities?: realtime.Modality[]): realtime.Modality[] {
  const resolved = modalities ?? ['audio'];
  if (resolved.length !== 1 || !['audio', 'text'].includes(resolved[0]!)) {
    throw new Error(
      `outputModalities must be exactly ['text'] or ['audio']; got ${JSON.stringify(resolved)}`,
    );
  }
  return [...resolved];
}

function isFatalBosonError(error: Record<string, unknown>): boolean {
  return FATAL_ERROR_CODES.has(String(error.code)) || error.type === 'insufficient_quota';
}

/** Boson Higgs speech-to-speech realtime model. @public */
export class RealtimeModel extends realtime.RealtimeModel {
  /** @internal */
  _bosonOptions: BosonOptions;
  protected sessions = new Set<RealtimeSession>();

  override label(): string {
    return 'boson.RealtimeModel';
  }

  override get model(): string {
    return this._bosonOptions.model;
  }

  override get provider(): string {
    return new URL(this._bosonOptions.url).host;
  }

  constructor(options: RealtimeModelOptions = {}) {
    const hasApiKey = Object.prototype.hasOwnProperty.call(options, 'apiKey');
    const apiKey = hasApiKey ? options.apiKey! : process.env.BOSON_API_KEY || undefined;
    if (apiKey === undefined) {
      throw new Error(
        'apiKey must be passed or BOSON_API_KEY must be set. Pass apiKey: null for an unauthenticated local server.',
      );
    }
    if (
      options.maxSessionDuration !== undefined &&
      options.maxSessionDuration !== null &&
      !(options.maxSessionDuration > 0)
    ) {
      throw new Error('maxSessionDuration must be positive or null');
    }

    const outputModalities = resolveModalities(options.outputModalities);
    const transcription = normalizeTranscription(options.inputAudioTranscription);
    const inputAudioTranscription =
      transcription ||
      options.inputAudioTranscriptionModel ||
      options.inputAudioTranscriptionLanguage
        ? {
            ...(transcription ?? {}),
            ...(options.inputAudioTranscriptionModel
              ? { model: options.inputAudioTranscriptionModel }
              : {}),
            ...(options.inputAudioTranscriptionLanguage !== undefined
              ? { language: options.inputAudioTranscriptionLanguage }
              : {}),
          }
        : undefined;
    const maxSessionDuration =
      options.maxSessionDuration !== undefined
        ? options.maxSessionDuration
        : transcriptionEnabled(inputAudioTranscription)
          ? DEFAULT_MAX_SESSION_DURATION
          : null;
    const turnDetection =
      options.turnDetection === undefined
        ? { ...DEFAULT_TURN_DETECTION }
        : options.turnDetection === false
          ? null
          : options.turnDetection;

    super({
      baseURL: options.url ?? DEFAULT_URL,
      apiKey: apiKey ?? 'boson',
      model: options.model ?? 'higgs-realtime',
      voice: options.voice ?? 'default',
      modalities: outputModalities,
      inputAudioTranscription: null,
      turnDetection: null,
      toolChoice: options.toolChoice ?? 'auto',
      speed: options.speed ?? 1,
      maxSessionDuration,
      connOptions: options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });

    this._bosonOptions = {
      url: normalizeWsUrl(options.url ?? DEFAULT_URL, options.queryParams),
      apiKey,
      model: options.model ?? 'higgs-realtime',
      voice: options.voice ?? 'default',
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens ?? 'inf',
      toolChoice: options.toolChoice ?? 'auto',
      speed: options.speed ?? 1,
      turnDetection: turnDetection ? { ...turnDetection } : null,
      inputAudioTranscription,
      noiseReduction: noiseReduction(options.inputAudioNoiseReduction),
      outputModalities,
      truncation: options.truncation ?? 'auto',
    };
    this.capabilities.turnDetection = turnDetection !== null;
    this.capabilities.canDisableTurnDetection = false;
    this.capabilities.userTranscription = transcriptionEnabled(inputAudioTranscription);
    this.capabilities.autoToolReplyGeneration = false;
    this.capabilities.audioOutput = outputModalities.includes('audio');
    this.capabilities.perResponseToolChoice = false;
  }

  override session(options?: llm.RealtimeSessionOptions): RealtimeSession {
    const session = new RealtimeSession(this, options);
    this.sessions.add(session);
    return session;
  }

  updateOptions(options: RealtimeSessionOptionsUpdate): void {
    applyOptions(this._bosonOptions, options);
    this.capabilities.turnDetection = this._bosonOptions.turnDetection !== null;
    this.capabilities.userTranscription = transcriptionEnabled(
      this._bosonOptions.inputAudioTranscription,
    );
    for (const session of this.sessions) session.updateOptions(options);
  }

  /** @internal */
  _forgetSession(session: RealtimeSession): void {
    this.sessions.delete(session);
  }
}

function applyOptions(target: BosonOptions, options: RealtimeSessionOptionsUpdate): void {
  if ('toolChoice' in options) target.toolChoice = options.toolChoice ?? null;
  if (options.voice !== undefined) target.voice = options.voice;
  if (options.speed !== undefined) target.speed = options.speed;
  if (options.temperature !== undefined) target.temperature = options.temperature;
  const maxTokens = options.maxOutputTokens ?? options.maxResponseOutputTokens;
  if (maxTokens != null) target.maxOutputTokens = maxTokens;
  if ('turnDetection' in options) {
    const value = options.turnDetection === false ? null : options.turnDetection;
    target.turnDetection = mergeSessionValue(
      target.turnDetection,
      value,
    ) as BosonOptions['turnDetection'];
  }
  if ('inputAudioTranscription' in options) {
    target.inputAudioTranscription = mergeSessionValue(
      target.inputAudioTranscription,
      normalizeTranscription(options.inputAudioTranscription),
    ) as BosonOptions['inputAudioTranscription'];
  }
  if ('inputAudioNoiseReduction' in options) {
    target.noiseReduction = mergeSessionValue(
      target.noiseReduction,
      noiseReduction(options.inputAudioNoiseReduction),
    ) as BosonOptions['noiseReduction'];
  }
  if (options.truncation != null) target.truncation = options.truncation;
}

/** A conversation on the Boson realtime API. @public */
export class RealtimeSession extends realtime.RealtimeSession {
  private bosonOptions?: BosonOptions;
  private currentResponseId?: string;
  private suppressNextCancel = false;
  private sessionIdValue?: string;
  private terminalReason?: string;
  private serverMaxDurationReached = false;
  private unsupportedToolWarned = false;
  private unsupportedRoleWarned = false;
  private perResponseToolsWarned = false;
  private inputSpeechStartedAt = new Map<string, number>();
  private chatCtxSyncError?: llm.RealtimeError;
  private chatCtxSyncTail: Promise<void> = Promise.resolve();

  private get opts(): BosonOptions {
    return this.bosonOptions ?? (this.oaiRealtimeModel as RealtimeModel)._bosonOptions;
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue;
  }

  constructor(model: RealtimeModel, options?: llm.RealtimeSessionOptions) {
    super(model, options);
    this.bosonOptions = {
      ...model._bosonOptions,
      turnDetection: model._bosonOptions.turnDetection
        ? { ...model._bosonOptions.turnDetection }
        : null,
      inputAudioTranscription: model._bosonOptions.inputAudioTranscription
        ? { ...model._bosonOptions.inputAudioTranscription }
        : undefined,
      noiseReduction: model._bosonOptions.noiseReduction
        ? { ...model._bosonOptions.noiseReduction }
        : null,
      outputModalities: [...model._bosonOptions.outputModalities],
    };
    this.on('openai_server_event_received', (event: realtime.ServerEvent) => {
      const raw = event as unknown as Record<string, unknown>;
      if (event.type === 'session.created' || event.type === 'session.updated') {
        const session = raw.session;
        if (isRecord(session) && typeof session.id === 'string') this.sessionIdValue = session.id;
      } else if (raw.type === 'session.idle_timeout') {
        this.terminalReason = `idle timeout (${String(raw.seconds_idle)}s)`;
      } else if (raw.type === 'session.max_duration_reached') {
        this.serverMaxDurationReached = true;
      }
    });
    this.on('session_reconnected', () => {
      this.pushedDurationMs = 0;
      this.currentResponseId = undefined;
      this.suppressNextCancel = false;
    });
  }

  protected override get metricsLabel(): string {
    return 'boson_realtime';
  }

  protected override createSessionUpdateEvent(): realtime.SessionUpdateEvent {
    const opts = this.opts;
    const input: Record<string, unknown> = {
      format: { type: 'audio/pcm', rate: 24000 },
      turn_detection: opts.turnDetection,
    };
    if (opts.inputAudioTranscription !== undefined) {
      input.transcription = opts.inputAudioTranscription;
    }
    if (opts.noiseReduction !== null) input.noise_reduction = opts.noiseReduction;
    const payload: Record<string, unknown> = {
      model: opts.model,
      output_modalities: [...opts.outputModalities],
      audio: {
        input,
        output: {
          format: { type: 'audio/pcm', rate: 24000 },
          voice: opts.voice,
          speed: opts.speed,
        },
      },
      tools: this.convertTools(this.tools.flatten()),
      tool_choice: toolChoiceToBoson(opts.toolChoice),
      max_output_tokens: opts.maxOutputTokens,
      truncation: opts.truncation,
    };
    if (opts.temperature !== undefined) payload.temperature = opts.temperature;
    if (this.instructions !== undefined) payload.instructions = this.instructions;
    return sessionUpdate('session_update_', payload);
  }

  protected override createToolsUpdateEvent(tools: llm.ToolContext): realtime.SessionUpdateEvent {
    return sessionUpdate('tools_update_', { tools: this.convertTools(tools.flatten()) });
  }

  private convertTools(tools: llm.Tool[]): realtime.Tool[] {
    const converted = toolsToBoson(tools);
    if (converted.length !== tools.length && !this.unsupportedToolWarned) {
      this.unsupportedToolWarned = true;
      log().warn('Boson realtime only supports function tools; unsupported tools were dropped');
    }
    return converted;
  }

  override async updateInstructions(instructions: string): Promise<void> {
    this.instructions = instructions;
    this.sendEvent(sessionUpdate('instructions_update_', { instructions }));
  }

  override async updateChatCtx(chatCtx: llm.ChatContext): Promise<void> {
    const previous = this.chatCtxSyncTail;
    let release!: () => void;
    this.chatCtxSyncTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.chatCtxSyncError = undefined;
      await super.updateChatCtx(chatCtx);
      if (this.chatCtxSyncError) throw this.chatCtxSyncError;
    } finally {
      release();
    }
  }

  override updateOptions(options: RealtimeSessionOptionsUpdate): void {
    const payload: Record<string, unknown> = {};
    const input: Record<string, unknown> = {};
    const output: Record<string, unknown> = {};
    applyOptions(this.opts, options);
    if ('toolChoice' in options) payload.tool_choice = toolChoiceToBoson(this.opts.toolChoice);
    if (options.voice !== undefined) output.voice = options.voice;
    if (options.speed !== undefined) output.speed = options.speed;
    if (options.temperature !== undefined) payload.temperature = options.temperature;
    const maxTokens = options.maxOutputTokens ?? options.maxResponseOutputTokens;
    if (maxTokens != null) payload.max_output_tokens = maxTokens;
    if ('turnDetection' in options) input.turn_detection = this.opts.turnDetection;
    if ('inputAudioTranscription' in options) {
      input.transcription = this.opts.inputAudioTranscription ?? null;
    }
    if ('inputAudioNoiseReduction' in options) input.noise_reduction = this.opts.noiseReduction;
    if (options.truncation != null) payload.truncation = options.truncation;
    if (Object.keys(input).length) payload.audio = { input };
    if (Object.keys(output).length) {
      const audio = (payload.audio ?? {}) as Record<string, unknown>;
      audio.output = output;
      payload.audio = audio;
    }
    if (Object.keys(payload).length) this.sendEvent(sessionUpdate('options_update_', payload));
  }

  override async generateReply(
    instructions?: string,
    options: { signal?: AbortSignal; toolChoice?: llm.ToolChoice; tools?: llm.Tool[] } = {},
  ): Promise<llm.GenerationCreatedEvent> {
    if (
      (options.toolChoice !== undefined || options.tools !== undefined) &&
      !this.perResponseToolsWarned
    ) {
      this.perResponseToolsWarned = true;
      log().warn('Boson realtime ignores per-response tools and toolChoice');
    }
    return super.generateReply(instructions, { signal: options.signal });
  }

  override async interrupt(): Promise<void> {
    if (!this.hasInflightResponse()) return;
    if (this.suppressNextCancel) {
      this.suppressNextCancel = false;
      return;
    }
    this.sendEvent({
      type: 'response.cancel',
      event_id: shortuuid('response_cancel_'),
      response_id: this.currentResponseId,
    });
  }

  protected override handleInputAudioBufferSpeechStarted(
    event: realtime.InputAudioBufferSpeechStartedEvent,
  ): void {
    this.suppressNextCancel = this.opts.turnDetection !== null;
    try {
      if (event.item_id && !this.inputSpeechStartedAt.has(event.item_id)) {
        this.inputSpeechStartedAt.set(event.item_id, Date.now());
      }
      super.handleInputAudioBufferSpeechStarted(event);
    } finally {
      this.suppressNextCancel = false;
    }
  }

  protected override handleInputAudioBufferSpeechStopped(
    _event: realtime.InputAudioBufferSpeechStoppedEvent,
  ): void {
    this.pushedDurationMs = 0;
    this.emit('input_speech_stopped', {
      userTranscriptionEnabled: transcriptionEnabled(this.opts.inputAudioTranscription),
    } as llm.InputSpeechStoppedEvent);
  }

  protected override handleConversationItemCreated(
    event: realtime.ConversationItemCreatedEvent,
  ): void {
    const existing = this.remoteChatCtx.get(event.item.id);
    if (existing) {
      const incoming = event.item;
      if (incoming.type === 'message' && existing.item instanceof llm.ChatMessage) {
        const content = Array.isArray(incoming.content) ? incoming.content : [incoming.content];
        const convertedText = content
          .flatMap((part) => ('text' in part && part.text ? [part.text] : []))
          .join('\n');
        if (convertedText) setMessageText(existing.item, convertedText);
      }
      const future = this.itemCreateFutures[event.item.id];
      if (future && !future.done) future.resolve();
      delete this.itemCreateFutures[event.item.id];
      return;
    }

    // Boson uses a null predecessor to append server-originated items, while
    // RemoteChatContext interprets it as insert-at-head. Client-create echoes
    // retain their requested predecessor and are tracked by itemCreateFutures.
    const previousItemId =
      !event.previous_item_id && !this.itemCreateFutures[event.item.id]
        ? this.chatCtx.items.at(-1)?.id ?? null
        : event.previous_item_id;
    super.handleConversationItemCreated({ ...event, previous_item_id: previousItemId });
  }

  protected override handleConversationItemInputAudioTranscriptionCompleted(
    event: realtime.ConversationItemInputAudioTranscriptionCompletedEvent,
  ): void {
    this.clearAccumulator(event.item_id, event.content_index ?? 0);
    const item = this.remoteChatCtx.get(event.item_id)?.item;
    const logprobs = event.logprobs
      ?.map((entry) => entry.logprob)
      .filter((value): value is number => value !== undefined);
    const confidence = logprobs?.length
      ? Math.exp(logprobs.reduce((total, value) => total + value, 0) / logprobs.length)
      : undefined;
    if (item instanceof llm.ChatMessage) {
      if (event.transcript) setMessageText(item, event.transcript);
      item.transcriptConfidence = confidence;
    }
    this.emit('input_audio_transcription_completed', {
      itemId: event.item_id,
      transcript: event.transcript,
      isFinal: true,
      confidence,
      turnStartedAt: this.inputSpeechStartedAt.get(event.item_id),
    } as llm.InputTranscriptionCompleted);
    if (event.usage?.seconds !== undefined) {
      this.emit('metrics_collected', {
        type: 'stt_metrics',
        label: 'boson_realtime_transcription',
        requestId: event.event_id ?? '',
        timestamp: Date.now(),
        durationMs: 0,
        audioDurationMs: event.usage.seconds * 1000,
        streamed: true,
        metadata: {
          modelProvider: this.oaiRealtimeModel.provider,
          modelName: String(this.opts.inputAudioTranscription?.model ?? ''),
        },
      } as metrics.STTMetrics);
    }
  }

  protected override handleConversationItemDeleted(
    event: realtime.ConversationItemDeletedEvent,
  ): void {
    super.handleConversationItemDeleted(event);
    this.inputSpeechStartedAt.delete(event.item_id);
  }

  protected override async createChatCtxUpdateEvents(
    chatCtx: llm.ChatContext,
  ): Promise<(realtime.ConversationItemCreateEvent | realtime.ConversationItemDeleteEvent)[]> {
    const sanitized = new llm.ChatContext();
    for (const item of chatCtx.items) {
      if (item.type === 'message') {
        if (item.role === 'system' || item.role === 'developer') {
          if (!this.unsupportedRoleWarned) {
            this.unsupportedRoleWarned = true;
            log().warn('Boson conversation sync drops system and developer messages');
          }
          continue;
        }
        const text = textFromContent(item.content);
        sanitized.items.push(
          llm.ChatMessage.create({ id: item.id, role: item.role, content: text ? [text] : [] }),
        );
      } else if (item.type === 'function_call' || item.type === 'function_call_output') {
        sanitized.items.push(item);
      }
    }

    const remote = this.chatCtx;
    const remoteIds = new Set(remote.items.map((item) => item.id));
    const diff = llm.computeChatCtxDiff(remote, sanitized);
    if (
      remote.items.length &&
      [...diff.toCreate, ...diff.toUpdate].some(([previous]) => previous === null)
    ) {
      return this.rebuildChatCtx(sanitized, remote.items);
    }

    const events: (realtime.ConversationItemCreateEvent | realtime.ConversationItemDeleteEvent)[] =
      diff.toRemove.map((id) => ({
        type: 'conversation.item.delete',
        item_id: id,
        event_id: shortuuid('chat_ctx_delete_'),
      }));
    const deleted = new Set(diff.toRemove);
    const dropped = new Map<string, string | null>();
    const add = (previous: string | null, id: string, updating: boolean) => {
      if (updating) {
        events.push({
          type: 'conversation.item.delete',
          item_id: id,
          event_id: shortuuid('chat_ctx_delete_'),
        });
        deleted.add(id);
      }
      while (previous && dropped.has(previous)) previous = dropped.get(previous) ?? null;
      const item = sanitized.getById(id);
      const payload = item ? livekitItemToBosonItem(item) : undefined;
      if (!payload) {
        dropped.set(id, previous);
        if (deleted.has(id) && remoteIds.has(id)) {
          log().warn({ itemIds: [id] }, 'Boson deleted a turn whose replacement has no text');
        }
        return;
      }
      events.push({
        type: 'conversation.item.create',
        event_id: shortuuid('chat_ctx_create_'),
        previous_item_id: previous,
        item: payload,
      });
    };
    for (const [previous, id] of diff.toCreate) add(previous, id, false);
    for (const [previous, id] of diff.toUpdate) add(previous, id, true);
    return events;
  }

  private rebuildChatCtx(
    chatCtx: llm.ChatContext,
    remoteItems: llm.ChatItem[],
  ): (realtime.ConversationItemCreateEvent | realtime.ConversationItemDeleteEvent)[] {
    const events: (realtime.ConversationItemCreateEvent | realtime.ConversationItemDeleteEvent)[] =
      remoteItems.map((item) => ({
        type: 'conversation.item.delete',
        item_id: item.id,
        event_id: shortuuid('chat_ctx_delete_'),
      }));
    const remoteIds = new Set(remoteItems.map((item) => item.id));
    const unrecreatable: string[] = [];
    let previous: string | null = null;
    for (const item of chatCtx.items) {
      const payload = livekitItemToBosonItem(item);
      if (!payload) {
        if (remoteIds.has(item.id)) unrecreatable.push(item.id);
        continue;
      }
      events.push({
        type: 'conversation.item.create',
        event_id: shortuuid('chat_ctx_create_'),
        previous_item_id: previous,
        item: payload,
      });
      previous = item.id;
    }
    if (unrecreatable.length) {
      log().warn(
        { itemIds: unrecreatable },
        'Boson conversation rebuild dropped untranscribed turns',
      );
    }
    return events;
  }

  private isStale(responseId?: string): boolean {
    if (this.currentGeneration instanceof realtime.DiscardedGeneration) return false;
    if (!this.currentGeneration) return true;
    return responseId !== undefined && responseId !== this.currentResponseId;
  }

  protected override handleResponseCreated(event: realtime.ResponseCreatedEvent): void {
    const clientEventId = event.response.metadata?.client_event_id;
    if (clientEventId && this.discardedEventIds.has(clientEventId)) {
      const active = this.currentGeneration;
      super.handleResponseCreated(event);
      if (active && !(active instanceof realtime.DiscardedGeneration))
        this.currentGeneration = active;
      return;
    }
    if (this.currentGeneration) this.closeCurrentGeneration('a newer Boson response started');
    this.currentResponseId = event.response.id;
    super.handleResponseCreated(event);
  }

  protected override handleResponseOutputItemAdded(
    event: realtime.ResponseOutputItemAddedEvent,
  ): void {
    if (!this.isStale(event.response_id)) super.handleResponseOutputItemAdded(event);
  }
  protected override handleResponseContentPartAdded(
    event: realtime.ResponseContentPartAddedEvent,
  ): void {
    if (!this.isStale(event.response_id)) super.handleResponseContentPartAdded(event);
  }
  protected override handleResponseTextDelta(event: realtime.ResponseTextDeltaEvent): void {
    if (!this.isStale(event.response_id)) super.handleResponseTextDelta(event);
  }
  protected override handleResponseTextDone(event: realtime.ResponseTextDoneEvent): void {
    if (!this.isStale(event.response_id)) super.handleResponseTextDone(event);
  }
  protected override handleResponseAudioTranscriptDelta(
    event: realtime.ResponseAudioTranscriptDeltaEvent,
  ): void {
    if (!this.isStale(event.response_id)) super.handleResponseAudioTranscriptDelta(event);
  }
  protected override handleResponseAudioDelta(event: realtime.ResponseAudioDeltaEvent): void {
    if (!this.isStale(event.response_id)) super.handleResponseAudioDelta(event);
  }
  protected override handleResponseAudioDone(event: realtime.ResponseAudioDoneEvent): void {
    if (!this.isStale(event.response_id)) super.handleResponseAudioDone(event);
  }
  protected override handleResponseOutputItemDone(
    event: realtime.ResponseOutputItemDoneEvent,
  ): void {
    if (this.isStale(event.response_id)) {
      if (event.item.type === 'function_call') {
        const item = this.remoteChatCtx.get(event.item.id)?.item;
        if (item instanceof llm.FunctionCall) item.args = event.item.arguments;
      }
      return;
    }
    super.handleResponseOutputItemDone(event);
  }
  protected override handleResponseDone(event: realtime.ResponseDoneEvent): void {
    if (this.isStale(event.response.id)) return;
    super.handleResponseDone(event);
    this.currentResponseId = undefined;
  }

  protected override handleError(event: realtime.ErrorEvent): void {
    const error = event.error as unknown as Record<string, unknown>;
    const eventId =
      (typeof error.event_id === 'string' && error.event_id) || event.event_id || undefined;
    const message = formatError(error, eventId);
    if (eventId) {
      const future = this.chatCtxEventFutures[eventId];
      if (future) {
        delete this.chatCtxEventFutures[eventId];
        const syncError = new llm.RealtimeError(message);
        if (error.type === 'invalid_previous_item_id') this.chatCtxSyncError = syncError;
        if (!future.done) future.reject(syncError);
        if (!isFatalBosonError(error)) return;
      }
    }
    if (error.code === 'input_audio_buffer_commit_empty' && this.opts.turnDetection !== null)
      return;
    if (
      NONFATAL_ERROR_CODES.has(String(error.code)) ||
      NONFATAL_ERROR_TYPES.has(String(error.type))
    ) {
      if (eventId) this.rejectNamedResponse(eventId, new llm.RealtimeError(message));
      const itemId = typeof error.item_id === 'string' ? error.item_id : undefined;
      if (error.type === 'invalid_previous_item_id' && itemId) {
        const future = this.itemCreateFutures[itemId];
        if (future) {
          const syncError = new llm.RealtimeError(message);
          this.chatCtxSyncError = syncError;
          if (!future.done) future.reject(syncError);
        }
      }
      return;
    }
    if (isFatalBosonError(error)) throw new APIError(message, { body: error, retryable: false });
    const realtimeError = new llm.RealtimeError(message);
    this.emitError({ error: realtimeError, recoverable: true });
    if (eventId) this.rejectNamedResponse(eventId, realtimeError);
  }

  private rejectNamedResponse(eventId: string, error: Error): void {
    const handle = this.responseCreatedFutures[eventId];
    if (!handle) return;
    delete this.responseCreatedFutures[eventId];
    if (handle.timeout) clearTimeout(handle.timeout);
    if (!handle.doneFut.done) handle.doneFut.reject(error);
  }

  protected override async createWsConn(): Promise<WebSocket> {
    const headers: Record<string, string> = { 'User-Agent': 'LiveKit Agents Boson plugin' };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url, { headers });
      let waiting = true;
      const fail = (error: Error) => {
        if (!waiting) return;
        waiting = false;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        fail(new APITimeoutError({ message: 'Boson realtime connection timed out' }));
        ws.terminate();
      }, this._options.connOptions.timeoutMs);
      ws.once('open', () => {
        if (!waiting) return;
        waiting = false;
        clearTimeout(timeout);
        resolve(ws);
      });
      ws.once('unexpected-response', (_request, response) => {
        fail(
          new APIConnectionError({
            message: `Boson realtime API refused the connection: ${response.statusCode ?? -1}`,
          }),
        );
        ws.terminate();
      });
      ws.once('error', (error) =>
        fail(
          new APIConnectionError({ message: `Boson realtime connection failed: ${error.message}` }),
        ),
      );
      ws.once('close', () =>
        fail(new APIConnectionError({ message: 'Boson realtime connection closed' })),
      );
    });
  }

  protected override async runWs(ws: WebSocket): Promise<void> {
    this.serverMaxDurationReached = false;
    return super.runWs(ws);
  }

  protected override websocketCloseError(code: number, _reason: string): Error | undefined {
    if (this.terminalReason) {
      return new APIConnectionError({
        message: `Boson realtime session ended by server: ${this.terminalReason}`,
        options: { retryable: false },
      });
    }
    if (this.serverMaxDurationReached) return undefined;
    return new APIConnectionError({
      message: `Boson realtime WebSocket closed unexpectedly (close_code=${code})`,
      options: { retryable: !NON_RETRYABLE_CLOSE_CODES.has(code) },
    });
  }

  protected override maxSessionDurationResult(): undefined {
    return undefined;
  }

  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      (this.oaiRealtimeModel as RealtimeModel)._forgetSession(this);
    }
  }
}
