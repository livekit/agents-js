// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIConnectionError,
  APIError,
  AudioByteStream,
  DEFAULT_API_CONNECT_OPTIONS,
  Future,
  intervalForRetry,
  llm,
  log,
  type metrics,
  shortuuid,
} from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { toResponsesTool } from '../tool_utils.js';
import type {
  ClientEvent,
  Delegation,
  DelegationTarget,
  InputItem,
  InputRole,
  ResponsesConfig,
  ResponsesEvent,
  ServerEvent,
} from './gpt_live_types.js';

const SAMPLE_RATE = 24000;
const MIN_SILENCE_DURATION = 800;
const DEFAULT_MODEL = 'gpt-live-1';
const DEFAULT_BACKEND_MODEL = 'gpt-5.6-luna';
const SPEAK_NOW = 'Do not wait for the caller to speak first. After that, pause and listen.';
const ASK_INSTRUCTED = `Immediately follow the instruction below. ${SPEAK_NOW}`;
const ASK_TYPED = `Reply to the caller now, don't repeat what they said. ${SPEAK_NOW}`;
const ASK_BARE = `Reply to the caller now. ${SPEAK_NOW}`;
const SESSION_CLOSE_TIMEOUT = 5000;
const FATAL_ERROR_CODES = new Set(['insufficient_quota', 'invalid_api_key']);

/** Settings for the backend Responses model. Unset fields use the service defaults.
 * @public
 */
export interface ResponsesDelegationOptions {
  /** Defaults to gpt-5.6-luna. */
  model?: string;
  /** Backend instructions, separate from the voice persona. */
  instructions?: string;
  toolChoice?: llm.ToolChoice | null;
  parallelToolCalls?: boolean;
  reasoning?: ResponsesConfig['reasoning'];
  text?: ResponsesConfig['text'];
  serviceTier?: ResponsesConfig['service_tier'];
  /** Maximum tokens per backend response; the service requires at least 16. */
  maxOutputTokens?: number;
}

/** Work handed to the application under client delegation.
 * @public
 */
export interface GPTLiveDelegation {
  /** Answer this id with GPTLiveSession.appendCommentary. */
  id: string;
  /** The caller's current turn, which may not yet be in the agent's chat context. */
  pendingTranscript: string;
}

/** Suggested GPT-Live voice names. Other supported names also pass through to the API. @public */
export type GPTLiveVoices = 'aster' | 'beacon' | 'cinder' | 'marin' | 'stone' | 'vesper';

/** Options for the OpenAI GPT-Live full-duplex voice model.
 * @public
 */
export interface GPTLiveModelOptions {
  model?: string;
  /**
   * A named voice (marin by default), or an authorized custom voice object. Fixed at startup.
   * Names pass through unchanged.
   */
  voice?: GPTLiveVoices | (string & NonNullable<unknown>) | Record<string, unknown>;
  /** Fixed at startup. Client delegation requires an agent with no tools. */
  delegation?: DelegationTarget;
  responsesOptions?: ResponsesDelegationOptions;
  /** Falls back to OPENAI_API_KEY. */
  apiKey?: string;
  /** Falls back to OPENAI_BASE_URL, then https://api.openai.com/v1. */
  baseURL?: string;
  /** Recycle the connection after this many milliseconds. */
  maxSessionDuration?: number | null;
  connOptions?: APIConnectOptions;
}

type LiveOptions = Required<GPTLiveModelOptions>;

/** OpenAI GPT-Live full-duplex voice model, ready to pass to AgentSession.
 * @public
 */
export class GPTLiveModel extends llm.DuplexModel {
  /** @internal */
  readonly _opts: Required<GPTLiveModelOptions>;

  constructor(options: GPTLiveModelOptions = {}) {
    super({
      userTranscription: true,
      autoToolReplyGeneration: true,
      midSessionChatCtxUpdate: false,
      midSessionInstructionsUpdate: false,
      midSessionToolsUpdate: (options.delegation ?? 'responses') === 'responses',
    });
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key is required: pass apiKey or set OPENAI_API_KEY');
    }
    this._opts = {
      model: options.model ?? DEFAULT_MODEL,
      voice: options.voice ?? 'marin',
      delegation: options.delegation ?? 'responses',
      responsesOptions: { ...options.responsesOptions },
      apiKey,
      baseURL: options.baseURL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      maxSessionDuration: options.maxSessionDuration ?? null,
      connOptions: { ...(options.connOptions ?? DEFAULT_API_CONNECT_OPTIONS) },
    };
  }

  get model(): string {
    return this._opts.model;
  }
  get provider(): string {
    return new URL(this._opts.baseURL).host;
  }

  audioGate(): llm.AudioGate {
    return new llm.FixedGate(0.0006, { minSilenceDuration: MIN_SILENCE_DURATION });
  }

  session(): GPTLiveSession {
    return new GPTLiveSession(this);
  }
  async close(): Promise<void> {}
}

type Role = 'user' | 'assistant';
interface Speech {
  messageId: string;
  text: string;
  endMs?: number;
  startedAt: number;
  quietMs: number;
}
interface DelegatedResponse {
  callIds: Set<string>;
  returned: Set<string>;
  completed: boolean;
}

/**
 * GPT-Live WebSocket session, accessible through Agent.duplexSession.
 * Also emits openai_server_event_received, openai_client_event_queued and delegation_created.
 * Append methods queue context without waiting for acknowledgment. The appended events arrive
 * at the estimated context-injection end and do not indicate speech completion.
 * @public
 */
export class GPTLiveSession extends llm.DuplexSession<{
  openai_server_event_received: (event: ServerEvent) => void;
  openai_client_event_queued: (event: ClientEvent | Record<string, unknown>) => void;
  delegation_created: (event: GPTLiveDelegation) => void;
}> {
  private readonly opts: LiveOptions;
  private readonly logger = log();
  private readonly debug = Number(process.env.LK_OPENAI_DEBUG ?? 0) !== 0;
  private readonly history = llm.ChatContext.empty();
  private readonly speech = new Map<Role, Speech>();
  private readonly delegatedResponses = new Map<string | null, DelegatedResponse>();
  private readonly callToDelegation = new Map<string, string | null>();
  private readonly bstream = new AudioByteStream(SAMPLE_RATE, 1, SAMPLE_RATE / 10);
  private inputResampler?: AudioResampler;
  private inputRate?: number;
  private _tools = llm.ToolContext.empty();
  private instructions?: string;
  private askedItemId?: string;
  private _sessionId?: string;
  private usageSeconds = 0;
  private sessionStartSent = false;
  private sessionStarted = false;
  private closing = false;
  private audioClosed = false;
  private readonly queued: (ClientEvent | Record<string, unknown>)[] = [];
  private ws?: WebSocket;
  private connectionDone?: Future<Error | undefined>;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private readonly shutdown = new AbortController();
  private readonly mainTask: Promise<void>;
  private audioController!: ReadableStreamDefaultController<llm.DuplexAudioFrame>;
  private readonly output = new ReadableStream<llm.DuplexAudioFrame>({
    start: (controller) => {
      this.audioController = controller;
    },
    cancel: () => {
      this.audioClosed = true;
    },
  });

  constructor(model: GPTLiveModel) {
    super(model);
    this.opts = { ...model._opts, responsesOptions: { ...model._opts.responsesOptions } };
    // Let the adapter attach error/metrics listeners before starting the connection.
    this.mainTask = Promise.resolve()
      .then(() => this.main())
      .catch((error) => {
        this.logger.error({ error }, 'GPT-Live session failed');
      });
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }
  get audioStream(): ReadableStream<llm.DuplexAudioFrame> {
    return this.output;
  }
  get tools(): llm.ToolContext {
    return this._tools.copy();
  }

  /** Queue a wire event. Commands wait for session.started before being sent. */
  sendEvent(event: ClientEvent | Record<string, unknown>): void {
    if (this.closing) return;
    this.queued.push(event);
    this.flushQueued();
  }

  private flushQueued(): void {
    if (!this.sessionStarted || this.ws?.readyState !== WebSocket.OPEN) return;
    while (this.queued.length) this.wsSend(this.ws, this.queued.shift()!);
  }

  private wsSend(ws: WebSocket, event: ClientEvent | Record<string, unknown>): void {
    this.emit('openai_client_event_queued', event);
    if (this.debug && event.type !== 'session.input_audio.append')
      this.logger.debug({ event }, 'GPT-Live client event');
    const done = this.connectionDone;
    ws.send(JSON.stringify(event), (error) => {
      if (error) done?.resolve(new APIConnectionError({ message: error.message }));
    });
  }

  private buildDelegation(): Delegation {
    if (this.opts.delegation === 'client') return { type: 'client' };
    const opts = this.opts.responsesOptions;
    const tools = this.buildTools();
    return {
      type: 'responses',
      responses: {
        model: opts.model ?? DEFAULT_BACKEND_MODEL,
        instructions: opts.instructions,
        tools: tools.length ? tools : undefined,
        tool_choice: opts.toolChoice !== undefined ? toToolChoice(opts.toolChoice) : undefined,
        parallel_tool_calls: opts.parallelToolCalls,
        reasoning: opts.reasoning,
        text: opts.text,
        service_tier: opts.serviceTier,
        max_output_tokens: opts.maxOutputTokens,
      },
    };
  }

  private buildTools(): NonNullable<ResponsesConfig['tools']> {
    return this._tools.flatten().flatMap((tool) => {
      const converted = toResponsesTool(tool, false);
      if (converted) return [converted];
      this.logger.debug({ tool: tool.id }, 'GPT-Live delegation ignores unsupported tool');
      return [];
    });
  }

  private sessionStartEvent(): ClientEvent {
    const items = this.history.items.flatMap((item): InputItem[] => {
      const rendered = renderItem(item);
      if (!rendered) return [];
      const [role, text] = rendered;
      return [
        {
          type: 'message',
          role,
          content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
        },
      ];
    });
    if (items.length > 128) {
      this.logger.warn(
        { dropped: items.length - 128, kept: 128 },
        'GPT-Live startup history exceeds the message limit; dropping the oldest',
      );
    }
    return {
      type: 'session.start',
      event_id: shortuuid('session_start_'),
      session: {
        model: this.opts.model,
        instructions: this.instructions,
        input: items.length ? items.slice(-128) : undefined,
        audio: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          output: { voice: this.opts.voice },
        },
        delegation: this.buildDelegation(),
      },
    };
  }

  private sendDelegationUpdate(responses: ResponsesConfig): void {
    if (this.opts.delegation !== 'responses' || !this.sessionStartSent) return;
    this.sendEvent({
      type: 'session.update',
      event_id: shortuuid('delegation_update_'),
      session: { delegation: { type: 'responses', responses } },
    } satisfies ClientEvent);
  }

  private async main(): Promise<void> {
    let retries = 0;
    let reconnecting = false;
    try {
      while (!this.closing) {
        try {
          await this.runConnection(() => {
            if (reconnecting) {
              this.endSpeech('user');
              this.speech.clear();
              this.delegatedResponses.clear();
              this.callToDelegation.clear();
              this.usageSeconds = 0;
              this._sessionId = undefined;
              retries = 0;
              this.emit('session_reconnected', {});
            }
          });
        } catch (error) {
          if (this.closing) break;
          const err = error instanceof Error ? error : new Error(String(error));
          const recoverable =
            err instanceof APIError && err.retryable && retries < this.opts.connOptions.maxRetry;
          this.emitError(err, recoverable);
          if (!recoverable) throw err;
          await delay(intervalForRetry(this.opts.connOptions, retries++), undefined, {
            signal: this.shutdown.signal,
          }).catch((error) => {
            if (!this.closing) throw error;
          });
        } finally {
          this.sessionStartSent = false;
          this.sessionStarted = false;
        }
        reconnecting = true;
      }
    } finally {
      if (!this.audioClosed) {
        this.audioClosed = true;
        this.audioController.close();
      }
    }
  }

  private async runConnection(onOpen: () => void): Promise<void> {
    const url = new URL(this.opts.baseURL);
    url.protocol =
      url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
    url.pathname = url.pathname.replace(/\/$/, '');
    if (!url.pathname.endsWith('/live/sessions')) url.pathname += '/live/sessions';
    url.search = '';
    url.hash = '';
    const done = new Future<Error | undefined>();
    this.connectionDone = done;
    const startTime = performance.now();
    const ws = new WebSocket(url, {
      headers: {
        'User-Agent': 'LiveKit Agents',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      handshakeTimeout: this.opts.connOptions.timeoutMs,
    });
    this.ws = ws;
    let recycleTimer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Future();
    ws.once('close', () => closed.resolve());
    ws.on('open', () => {
      this._reportConnectionAcquired(performance.now() - startTime);
      onOpen();
      if (this.opts.maxSessionDuration !== null) {
        recycleTimer = setTimeout(() => done.resolve(undefined), this.opts.maxSessionDuration);
      }
      void Promise.race([this._configured.wait(), done.await])
        .then(() => {
          if (this.closing || done.done) return;
          this.sessionStartSent = true;
          this.wsSend(ws, this.sessionStartEvent());
        })
        .catch((error: Error) => done.resolve(error));
    });
    ws.on('error', (error) => done.resolve(new APIConnectionError({ message: error.message })));
    ws.on('close', () =>
      done.resolve(
        this.closing
          ? undefined
          : new APIConnectionError({ message: 'OpenAI Live API connection closed unexpectedly' }),
      ),
    );
    ws.on('message', (data, isBinary) => {
      if (isBinary || done.done) return;
      try {
        const event = JSON.parse(data.toString()) as ServerEvent;
        this.emit('openai_server_event_received', event);
        if (this.debug && event.type !== 'session.output_audio.delta')
          this.logger.debug({ event }, 'GPT-Live server event');
        if (
          this.closing &&
          event.type !== 'session.usage.updated' &&
          event.type !== 'session.closed'
        )
          return;
        this.handleEvent(event);
      } catch (error) {
        if (error instanceof APIError && !error.retryable) done.resolve(error);
        else this.logger.error({ error }, 'Failed to handle GPT-Live event');
      }
    });
    try {
      const error = await done.await;
      if (error) throw error;
    } finally {
      this.sessionStartSent = false;
      this.sessionStarted = false;
      clearTimeout(recycleTimer);
      clearTimeout(this.closeTimer);
      this.ws = undefined;
      this.connectionDone = undefined;
      ws.terminate();
      await closed.await;
    }
  }

  private handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'session.started':
        this._sessionId = event.session?.id ?? this._sessionId;
        this.sessionStarted = true;
        this.flushQueued();
        break;
      case 'session.output_audio.delta': {
        const data = Buffer.from(event.delta ?? '', 'base64');
        if (!data.length || this.audioClosed) break;
        const samples = new Int16Array(data.length / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2);
        this.audioController.enqueue({
          frame: new AudioFrame(samples, SAMPLE_RATE, 1, samples.length),
        });
        break;
      }
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta':
        this.handleTranscript(
          event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
          event,
        );
        break;
      case 'session.delegation.created': {
        const delegation = event.delegation;
        if (!delegation?.id)
          this.logger.warn('GPT-Live delegation has no id; nothing can answer it');
        else if (delegation.target === 'client')
          this.emit('delegation_created', {
            id: delegation.id,
            pendingTranscript: this.speech.get('user')?.text ?? '',
          } satisfies GPTLiveDelegation);
        break;
      }
      case 'response.event':
        this.handleResponseEvent(event.delegation_id ?? null, event.event ?? { type: '' });
        break;
      case 'session.usage.updated':
      case 'session.closed':
        if (event.type === 'session.closed')
          this.logger.debug(
            { reason: event.reason ?? null, sessionId: this._sessionId },
            'GPT-Live session closed',
          );
        if (event.context_window?.usage_ratio != null)
          this.logger.debug(
            { usageRatio: event.context_window.usage_ratio },
            'GPT-Live context window utilization',
          );
        this.handleUsage(event.usage?.seconds ?? 0);
        if (event.type === 'session.closed' && this.closing)
          this.connectionDone?.resolve(undefined);
        break;
      case 'error': {
        const error = event.error ?? {};
        const recoverable = !FATAL_ERROR_CODES.has(error.code || error.type || '');
        const apiError = new APIError(error.message || 'OpenAI Live API returned an error', {
          body: error,
          retryable: recoverable,
        });
        if (!recoverable) throw apiError;
        this.emitError(apiError, true);
        break;
      }
      default:
        this.logger.debug({ type: event.type }, 'GPT-Live acknowledged a command');
    }
  }

  private handleTranscript(
    role: Role,
    event: { delta?: string; start_ms?: number | null; end_ms?: number | null },
  ): void {
    if (!event.delta) return;
    let speech = this.speech.get(role);
    if (
      speech?.endMs !== undefined &&
      event.start_ms != null &&
      event.start_ms - speech.endMs > MIN_SILENCE_DURATION
    ) {
      this.endSpeech(role);
      speech = undefined;
    }
    if (!speech) {
      speech = { messageId: shortuuid('speech_'), text: '', startedAt: Date.now(), quietMs: 0 };
      this.speech.set(role, speech);
      this.history.insert(
        new llm.ChatMessage({
          id: speech.messageId,
          role,
          content: [''],
          transcriptConfidence: role === 'user' ? 1 : undefined,
        }),
      );
      if (role === 'user') this.emit('input_speech_started', {});
    }
    speech.text += event.delta;
    speech.quietMs = 0;
    if (event.end_ms != null) speech.endMs = Math.max(speech.endMs ?? 0, event.end_ms);
    const message = this.history.getById(speech.messageId);
    if (message?.type === 'message') message.content[0] = speech.text;
    if (role === 'user') {
      this.emit('input_audio_transcription_completed', {
        itemId: speech.messageId,
        transcript: speech.text,
        isFinal: false,
        turnStartedAt: speech.startedAt,
      } satisfies llm.InputTranscriptionCompleted);
    } else {
      this.emit('transcript_delta', {
        text: event.delta,
        startMs: event.start_ms ?? undefined,
        endMs: event.end_ms ?? undefined,
      } satisfies llm.DuplexOutputTranscriptDelta);
    }
  }

  private endSpeech(role: Role): void {
    const speech = this.speech.get(role);
    this.speech.delete(role);
    if (!speech || role !== 'user') return;
    this.emit('input_audio_transcription_completed', {
      itemId: speech.messageId,
      transcript: speech.text,
      isFinal: true,
      turnStartedAt: speech.startedAt,
    } satisfies llm.InputTranscriptionCompleted);
    this.emit('input_speech_stopped', {
      userTranscriptionEnabled: false,
    } satisfies llm.InputSpeechStoppedEvent);
  }

  private handleResponseEvent(delegationId: string | null, event: ResponsesEvent): void {
    switch (event.type) {
      case 'response.created':
        this.delegatedResponses.set(delegationId, {
          callIds: new Set(),
          returned: new Set(),
          completed: false,
        });
        break;
      case 'response.output_item.done': {
        const item = event.item;
        if (!item || item.type !== 'function_call') return;
        if (!item.call_id || !item.name || item.arguments == null) {
          this.logger.warn(
            { callId: item.call_id, name: item.name },
            'GPT-Live dropping function call with missing fields',
          );
          return;
        }
        let pending = this.delegatedResponses.get(delegationId);
        if (!pending) {
          this.logger.warn(
            { callId: item.call_id, delegationId },
            'GPT-Live function call outside a known response',
          );
          pending = { callIds: new Set(), returned: new Set(), completed: true };
          this.delegatedResponses.set(delegationId, pending);
        }
        pending.callIds.add(item.call_id);
        this.callToDelegation.set(item.call_id, delegationId);
        const call = new llm.FunctionCall({
          id: item.id ?? shortuuid('fc_'),
          callId: item.call_id,
          name: item.name,
          args: item.arguments,
        });
        this.history.insert(call);
        this.emit('function_call', call);
        break;
      }
      case 'response.completed': {
        const response = event.response;
        const usage = response?.usage;
        if (usage) {
          const metric: metrics.LLMMetrics & { reasoningTokens: number } = {
            type: 'llm_metrics',
            label: this.duplexModel.label(),
            requestId: response?.id ?? '',
            timestamp: Date.now(),
            durationMs: 0,
            ttftMs: -1,
            cancelled: false,
            tokensPerSecond: 0,
            promptTokens: usage.input_tokens ?? 0,
            promptCachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
            cacheCreationTokens: usage.input_tokens_details?.cache_write_tokens ?? 0,
            completionTokens: usage.output_tokens ?? 0,
            reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
            metadata: {
              modelName:
                response?.model || this.opts.responsesOptions.model || DEFAULT_BACKEND_MODEL,
              modelProvider: this.duplexModel.provider,
            },
          };
          this.emit('metrics_collected', metric);
        }
        const pending = this.delegatedResponses.get(delegationId);
        if (pending) {
          pending.completed = true;
          this.maybeContinueResponse(delegationId);
        }
        break;
      }
      case 'response.failed':
      case 'response.incomplete': {
        this.logger.warn(
          {
            type: event.type,
            delegationId,
            error: event.response?.error,
            incompleteDetails: event.response?.incomplete_details,
          },
          'GPT-Live backend response did not complete',
        );
        const pending = this.delegatedResponses.get(delegationId);
        for (const callId of pending?.callIds ?? []) this.callToDelegation.delete(callId);
        this.delegatedResponses.delete(delegationId);
        break;
      }
    }
  }

  private maybeContinueResponse(delegationId: string | null): void {
    const pending = this.delegatedResponses.get(delegationId);
    if (!pending?.completed || [...pending.callIds].some((id) => !pending.returned.has(id))) return;
    this.delegatedResponses.delete(delegationId);
    if (!pending.callIds.size) return;
    for (const callId of pending.callIds) this.callToDelegation.delete(callId);
    this.sendEvent({
      type: 'response.create',
      event_id: shortuuid('response_create_'),
    } satisfies ClientEvent);
  }

  private handleUsage(seconds: number): void {
    const previous = this.usageSeconds;
    this.usageSeconds = seconds;
    this.emit('metrics_collected', {
      type: 'realtime_model_metrics',
      label: this.duplexModel.label(),
      requestId: this._sessionId ?? '',
      timestamp: Date.now(),
      durationMs: 0,
      ttftMs: -1,
      cancelled: false,
      sessionDurationMs: Math.max(0, seconds - previous) * 1000,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      tokensPerSecond: 0,
      inputTokenDetails: { audioTokens: 0, textTokens: 0, imageTokens: 0, cachedTokens: 0 },
      outputTokenDetails: { audioTokens: 0, textTokens: 0, imageTokens: 0 },
      metadata: { modelName: this.duplexModel.model, modelProvider: this.duplexModel.provider },
    } satisfies metrics.RealtimeModelMetrics);
  }

  private emitError(error: Error, recoverable: boolean): void {
    this.emit('error', {
      type: 'realtime_model_error',
      timestamp: Date.now(),
      label: this.duplexModel.label(),
      error,
      recoverable,
    } satisfies llm.RealtimeModelError);
  }

  pushAudio(frame: AudioFrame): void {
    if (this.closing) return;
    const speech = this.speech.get('user');
    if (speech) {
      speech.quietMs += Math.round((frame.samplesPerChannel / frame.sampleRate) * 1000);
      if (speech.quietMs >= MIN_SILENCE_DURATION) this.endSpeech('user');
    }
    if (frame.channels !== 1) {
      const mono = new Int16Array(frame.samplesPerChannel);
      for (let i = 0; i < mono.length; i++) {
        let sum = 0;
        for (let channel = 0; channel < frame.channels; channel++)
          sum += frame.data[i * frame.channels + channel]!;
        mono[i] = Math.round(sum / frame.channels);
      }
      frame = new AudioFrame(mono, frame.sampleRate, 1, mono.length);
    }
    if (this.inputRate !== frame.sampleRate) {
      this.inputResampler =
        frame.sampleRate === SAMPLE_RATE
          ? undefined
          : new AudioResampler(frame.sampleRate, SAMPLE_RATE, 1);
      this.inputRate = frame.sampleRate;
    }
    for (const resampled of this.inputResampler ? this.inputResampler.push(frame) : [frame]) {
      for (const chunk of this.bstream.write(resampled.data)) {
        this.sendEvent({
          type: 'session.input_audio.append',
          audio: Buffer.from(
            chunk.data.buffer,
            chunk.data.byteOffset,
            chunk.data.byteLength,
          ).toString('base64'),
        } satisfies ClientEvent);
      }
    }
  }

  /** Add a standing rule. The service enforces a 500-token cap on each append. */
  appendInstructions(text: string, options: { delegationId?: string | null } = {}): void {
    this.append('session.instructions.append', text, options.delegationId ?? null);
  }
  /** Add silent context for later replies. The service enforces a 500-token cap. */
  appendThinking(text: string, options: { delegationId?: string | null } = {}): void {
    this.append('session.thinking.append', text, options.delegationId ?? null);
  }
  /** Give the model text to paraphrase aloud, or answer a client delegation. Capped at 500 tokens by the service. */
  appendCommentary(text: string, options: { delegationId?: string | null } = {}): void {
    this.append('session.commentary.append', text, options.delegationId ?? null);
  }
  private append(
    type: 'session.instructions.append' | 'session.thinking.append' | 'session.commentary.append',
    content: string,
    delegationId: string | null,
  ): void {
    this.sendEvent({
      type,
      event_id: shortuuid('append_'),
      delegation_id: delegationId,
      content,
    } satisfies ClientEvent);
  }
  /** Replace microphone input with silence while the model continues speaking. */
  muteInput(): void {
    this.sendEvent({
      type: 'session.input_audio.mute',
      event_id: shortuuid('mute_'),
    } satisfies ClientEvent);
  }
  /** Restore microphone input. */
  unmuteInput(): void {
    this.sendEvent({
      type: 'session.input_audio.unmute',
      event_id: shortuuid('unmute_'),
    } satisfies ClientEvent);
  }

  protected async closeConnection(): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      this.shutdown.abort();
      if (this.sessionStarted && this.ws?.readyState === WebSocket.OPEN) {
        this.closeTimer = setTimeout(
          () => this.connectionDone?.resolve(undefined),
          SESSION_CLOSE_TIMEOUT,
        );
        this.wsSend(this.ws, { type: 'session.close' } satisfies ClientEvent);
      } else {
        this.connectionDone?.resolve(undefined);
      }
    }
    await this.mainTask;
  }

  async _updateInstructions(instructions: string): Promise<void> {
    if (this.sessionStartSent && instructions !== this.instructions) {
      throw new llm.RealtimeError(
        'gpt-live voice instructions are immutable after session start; use appendInstructions for a standing rule',
      );
    }
    this.instructions = instructions;
  }
  async _updateTools(tools: llm.ToolContext): Promise<void> {
    if (this.opts.delegation === 'client' && tools.flatten().length) {
      throw new llm.RealtimeError(
        `gpt-live client delegation has no tool channel, so the model can never call ${tools
          .flatten()
          .map((tool) => tool.id)
          .sort()
          .join(
            ', ',
          )}. Leave the agent's tools empty and answer delegation_created with appendCommentary, or pass delegation="responses" to run tools on the backend model.`,
      );
    }
    this._tools = tools.copy();
    this.sendDelegationUpdate({ tools: this.buildTools() });
  }
  async _appendItems(items: llm.ChatItem[]): Promise<void> {
    this.history.insert(items);
    if (!this.sessionStartSent) return;
    const outputs: { output: llm.FunctionCallOutput; delegationId: string | null }[] = [];
    const lines: string[] = [];
    for (const item of items) {
      if (item.type === 'message' && (item.role === 'system' || item.role === 'developer')) {
        if (item.textContent) this.appendInstructions(item.textContent);
      } else if (item.type === 'function_call_output' && this.callToDelegation.has(item.callId)) {
        outputs.push({ output: item, delegationId: this.callToDelegation.get(item.callId)! });
      } else {
        const rendered = renderItem(item);
        if (rendered) lines.push(`${rendered[0]}: ${rendered[1]}`);
      }
    }
    if (lines.length) this.appendThinking(lines.join('\n'));
    for (const { output, delegationId } of outputs) {
      this.sendEvent({
        type: 'response.item.create',
        event_id: shortuuid('tool_output_'),
        item: { type: 'function_call_output', call_id: output.callId, output: output.output },
      } satisfies ClientEvent);
      this.delegatedResponses.get(delegationId)?.returned.add(output.callId);
      this.maybeContinueResponse(delegationId);
    }
  }
  _generateReply(instructions?: string): void {
    if (instructions !== undefined) {
      this.appendCommentary(`${ASK_INSTRUCTED}\n\n${instructions}`);
      return;
    }
    const newest = this.history.items.at(-1);
    const typed =
      newest?.type === 'message' &&
      newest.role === 'user' &&
      newest.transcriptConfidence === undefined &&
      newest.id !== this.askedItemId
        ? newest.textContent
        : undefined;
    this.askedItemId = newest?.id;
    this.appendCommentary(typed ? `${ASK_TYPED}\n\n${typed}` : ASK_BARE);
  }
  _updateOptions(options: { toolChoice?: llm.ToolChoice | null }): void {
    if (options.toolChoice !== undefined) {
      this.opts.responsesOptions.toolChoice = options.toolChoice;
      this.sendDelegationUpdate({ tool_choice: toToolChoice(options.toolChoice) });
    }
  }
}

function toToolChoice(choice: llm.ToolChoice | null): NonNullable<ResponsesConfig['tool_choice']> {
  return typeof choice === 'string'
    ? choice
    : choice?.type === 'function'
      ? { type: 'function', name: choice.function.name }
      : 'auto';
}

function renderItem(item: llm.ChatItem): [InputRole, string] | undefined {
  if (item.type === 'message') {
    if (item.textContent)
      return [item.role === 'system' ? 'developer' : item.role, item.textContent];
  } else if (item.type === 'function_call') {
    return ['developer', `Called tool ${item.name} with ${item.args}`];
  } else if (item.type === 'function_call_output') {
    return [
      'developer',
      `Tool ${item.name || item.callId} ${item.isError ? 'failed with' : 'returned'} ${item.output}`,
    ];
  }
  return undefined;
}
