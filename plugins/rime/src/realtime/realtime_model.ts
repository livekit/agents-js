// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type * as r from '@rimelabs/sdk';
import { validateEndpoint } from '../options.js';
import { HistoryUpdateError, PrismHistory } from './history.js';
import { OutputQueue, SerialQueue } from './streams.js';

/** Prism connection settings. The model copies values and retains a supplied client by reference. */
export interface RealtimeModelOptions {
  /** API key. The SDK uses RIME_API_KEY when omitted. Cannot be combined with client. */
  apiKey?: string;
  /** A caller-owned client. The plugin closes only its session. */
  client?: r.Rime;
  /** Defaults to wss://prism.api.rime.ai/v1/realtime. */
  endpoint?: string;
  /** Allow a trusted endpoint outside rime.ai. Secure transport is still required outside loopback. */
  allowCustomEndpoint?: boolean;
  /** Voice ID. Uses the deployment default when omitted. */
  voice?: string;
  /** Server turn detection settings. endOfTurnTimeoutMs uses milliseconds. */
  turnDetection?: r.TurnDetection;
  /** Provider history truncation policy, separate from interrupted audio playback. */
  truncation?: r.Truncation;
  /** Timeout in milliseconds. Default: 10000. */
  connectTimeout?: number;
  /** Admission timeout in milliseconds. Default: 30000. */
  readyTimeout?: number;
  /** Acknowledgment timeout in milliseconds. Default: 10000. */
  requestTimeout?: number;
  /** Caller request ID for the connection. */
  requestId?: string;
  /** Labels attached to provider responses. */
  responseMetadata?: r.Labels;
  /** Filler speech by registered function tool name. */
  toolFillers?: Record<string, r.PrismFiller>;
}

/** Mutable provider settings. Omitted fields keep their current values. */
export interface SessionOptions {
  /** Voice ID for subsequent responses. */
  voice?: string;
  /** Provider history truncation policy. */
  truncation?: r.Truncation;
  /** Replacement response labels, acknowledged separately from other settings. */
  responseMetadata?: r.Labels;
  /** Replacement filler speech map, keyed by registered function tool name. */
  toolFillers?: Record<string, r.PrismFiller>;
}

/** Standard LiveKit generation streams with Prism response diagnostics. */
export interface PrismGenerationCreatedEvent extends llm.GenerationCreatedEvent {
  /** Snapshot of labels on this response. */
  metadata: r.Labels;
  /** Provider history item IDs used to start this response. */
  inputItemIds: readonly string[];
  /** Settings revision used by this response, or null when unavailable. */
  settingsRevision: number | null;
  /** Provider request ID for the connection, or null when unavailable. */
  providerRequestId: string | null;
}

/** Safe provider diagnostics. Provider error text is deliberately excluded. */
export class PrismError extends llm.RealtimeError {
  /** Validated provider code, or provider_error for an unsafe code. */
  readonly code: string;
  /** Provider fault scope, such as session, response, event, or tool roundtrip. */
  readonly scope: r.RealtimeFault['scope'];
  /** Request associated with this fault, when available. */
  readonly requestId: string | null;
  /** Response associated with this fault, when available. */
  readonly responseId: string | null;
  /** Provider retry guidance. The adapter does not retry the operation automatically. */
  readonly retryable: boolean;

  /** Create an error from SDK diagnostics without copying provider error text. */
  constructor(fault: r.NormalizedRealtimeFault) {
    const code = /^[a-z_]{1,80}$/.test(fault.code) ? fault.code : 'provider_error';
    super(`Prism operation failed (${code})`);
    this.code = code;
    this.scope = fault.scope;
    this.requestId = fault.requestId;
    this.responseId = fault.responseId;
    this.retryable = fault.retryable;
  }
}

/** Prism speech-to-speech model. Owns at most one open conversation at a time. */
export class RealtimeModel extends llm.RealtimeModel {
  private active?: RealtimeSession;
  private closed = false;
  private readonly options: RealtimeModelOptions;

  /** Copy connection settings. Opening a session starts the connection asynchronously. */
  constructor(options: RealtimeModelOptions = {}) {
    super({
      messageTruncation: true,
      turnDetection: true,
      canDisableTurnDetection: false,
      supportsOverlappingSpeech: false,
      userTranscription: true,
      autoToolReplyGeneration: false,
      audioOutput: true,
      manualFunctionCalls: false,
      midSessionChatCtxUpdate: true,
      midSessionInstructionsUpdate: true,
      midSessionToolsUpdate: true,
      perResponseToolChoice: false,
    });
    validateEndpoint(
      options.endpoint ?? 'wss://prism.api.rime.ai/v1/realtime',
      options.allowCustomEndpoint,
      true,
    );
    for (const value of [options.connectTimeout, options.readyTimeout, options.requestTimeout]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0))
        throw new llm.RealtimeError('Prism timeouts must be positive finite milliseconds');
    }
    if (options.client && options.apiKey)
      throw new llm.RealtimeError('Provide either a Rime client or an API key');
    this.options = {
      ...options,
      turnDetection: options.turnDetection && structuredClone(options.turnDetection),
      truncation: options.truncation && structuredClone(options.truncation),
      toolFillers: structuredClone(options.toolFillers ?? {}),
      responseMetadata: options.responseMetadata && { ...options.responseMetadata },
    };
  }
  /** Provider model name. */
  get model(): string {
    return 'prism';
  }
  /** Provider name. */
  get provider(): string {
    return 'rime';
  }
  /** Plugin label used in logs and errors. */
  override label(): string {
    return 'rime.RealtimeModel';
  }
  /** Copy of acknowledged session information, available after connection. */
  get sessionInfo(): r.SessionInfo | undefined {
    return this.active?.sessionInfo;
  }
  /** Open a conversation. Close the previous session first; server turn detection is required. */
  session(options: { turnDetectionDisabled?: boolean } = {}): RealtimeSession {
    if (this.closed) throw new llm.RealtimeError('Rime model is closed');
    if (options.turnDetectionDisabled)
      throw new llm.RealtimeError('Prism requires server turn detection');
    if (this.active && !this.active.isClosed)
      throw new llm.RealtimeError('Close the previous Prism session before opening another');
    this.active = new RealtimeSession(this, this.options);
    return this.active;
  }
  /**
   * Copy and apply settings to the current session. Each acknowledged change persists for
   * future sessions, even if a later metadata update fails. The update is not atomic.
   */
  async updateSession(options: SessionOptions): Promise<void> {
    if (!this.active) throw new llm.RealtimeError('Prism session is not open');
    await this.active.updateSession(options);
  }
  /** Read completed provider history without replacing the local conversation record. */
  async getHistory(): Promise<readonly r.HistoryItem[]> {
    if (!this.active) throw new llm.RealtimeError('Prism session is not open');
    return this.active.getHistory();
  }
  /** Close the active session and prevent new sessions. A caller-owned SDK client remains open. */
  async close(): Promise<void> {
    this.closed = true;
    await this.active?.close();
  }
}

interface Message {
  output: r.OutputRef;
  text: OutputQueue<string>;
  audio: OutputQueue<AudioFrame>;
  transcript: string;
  playedTranscript?: string;
  discarded: boolean;
}
interface Generation {
  ref: r.ResponseRef;
  event: PrismGenerationCreatedEvent;
  messages: OutputQueue<llm.MessageGeneration>;
  functions: OutputQueue<llm.FunctionCall>;
  outputs: Map<string, Message>;
  ended: boolean;
  abandoned: boolean;
  toolsDisabled: boolean;
}

/** One Prism conversation using the published SDK and the standard LiveKit session. */
export class RealtimeSession extends llm.RealtimeSession {
  private sdk?: r.RealtimeSession;
  private sdkTypes?: typeof r;
  private client?: r.Rime;
  private history?: PrismHistory;
  private initialized: Promise<void>;
  private lifetime = new AbortController();
  private closing?: Promise<void>;
  private closed = false;
  private fullyClosed = false;
  private failure?: llm.RealtimeError;
  private tasks = new Set<Promise<unknown>>();
  private settings = new SerialQueue();
  private input = new SerialQueue();
  private inputCount = 0;
  private pendingInput?: { data: Uint8Array; length: number; format: r.PCMFormat };
  private audioFormat?: string;
  private resampler?: AudioResampler;
  private toolContext = llm.ToolContext.empty();
  private fillers: Record<string, r.PrismFiller>;
  private toolChoice: 'auto' | 'none' = 'auto';
  private suppressTools = false;
  private suppressionPendingAfter?: number;
  private suppressedRevisions = new Set<number>();
  private policyFloor = 0;
  private generations = new Map<string, Generation>();
  private generationWaiters = new Map<
    string,
    { resolve: (g: Generation) => void; reject: (error: Error) => void }
  >();
  private turnStarted = new Map<string, number>();
  private transcripts = new Map<string, string>();
  private latest?: r.ResponseRef;
  private active?: r.ResponseRef;
  private parent?: r.ResponseRef;
  private report?: r.ToolCallRef;

  /** @internal Construct sessions with RealtimeModel.session(). */
  constructor(
    model: RealtimeModel,
    private readonly options: RealtimeModelOptions,
  ) {
    super(model);
    this.fillers = structuredClone(options.toolFillers ?? {});
    this.initialized = this.connect();
    void this.initialized.catch((error: unknown) => {
      if (!this.closed) this.fatal(error);
    });
  }
  /** True after connection, stream, and pending operation cleanup has finished. */
  get isClosed(): boolean {
    return this.fullyClosed;
  }
  /** Independent copy of acknowledged SDK session information, available after connection. */
  get sessionInfo(): r.SessionInfo | undefined {
    return this.sdk && structuredClone(this.sdk.info);
  }
  /** Independent copy of local history, including observed live messages and tool calls. */
  get chatCtx(): llm.ChatContext {
    return this.history?.chatCtx ?? llm.ChatContext.empty();
  }
  /** Copy of the acknowledged tool context. */
  get tools(): llm.ToolContext {
    return this.toolContext.copy();
  }

  private async connect(): Promise<void> {
    // Native import remains asynchronous in the CommonJS build. SDK has no require export.
    this.sdkTypes = await import('@rimelabs/sdk');
    this.lifetime.signal.throwIfAborted();
    this.client = this.options.client ?? new this.sdkTypes.Rime({ apiKey: this.options.apiKey });
    const sdk = await this.client.realtime.connect({
      endpoint: this.options.endpoint,
      voice: this.options.voice,
      turnDetection: this.options.turnDetection,
      truncation: this.options.truncation,
      interruptOnSpeech: true,
      requestId: this.options.requestId,
      responseMetadata: this.options.responseMetadata,
      timeouts: {
        connectS: (this.options.connectTimeout ?? 10000) / 1000,
        readyS: (this.options.readyTimeout ?? 30000) / 1000,
        requestS: (this.options.requestTimeout ?? 10000) / 1000,
      },
      signal: this.lifetime.signal,
    });
    this.sdk = sdk;
    if (this.closed) {
      await sdk.close();
      return;
    }
    this.history = new PrismHistory(sdk);
    this.emit('session_updated', this.sessionInfo);
    this.background(this.readEvents());
  }
  private requireSdk(): r.RealtimeSession {
    if (this.failure) throw this.failure;
    if (!this.sdk || this.closed) throw new llm.RealtimeError('Prism session is not open');
    return this.sdk;
  }
  private normalize(error: unknown): llm.RealtimeError {
    if (error instanceof llm.RealtimeError) return error;
    if (this.sdkTypes && error instanceof this.sdkTypes.RimeRealtimeError)
      return new PrismError(error.fault);
    // Do not leak credentials, endpoint queries, transcripts, or provider error text.
    return new llm.RealtimeError('Prism operation failed');
  }
  private track<T>(task: Promise<T>): Promise<T> {
    if (this.tasks.size >= 256) {
      this.fatal(new llm.RealtimeError('Too many pending Prism operations'));
    }
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
  private background(task: Promise<unknown>): void {
    void this.track(task).catch((error: unknown) => {
      if (!this.closed) this.fatal(error);
    });
  }
  private operation<T>(fn: () => Promise<T>): Promise<T> {
    return this.track(
      (async () => {
        try {
          await this.initialized;
          this.requireSdk();
          return await fn();
        } catch (error) {
          const safe = this.normalize(error);
          const known =
            (error instanceof DOMException && error.name === 'AbortError') ||
            (error instanceof HistoryUpdateError && !error.partial) ||
            (this.sdkTypes &&
              (error instanceof this.sdkTypes.RimeInputError ||
                error instanceof this.sdkTypes.RimeCancelledError ||
                error instanceof this.sdkTypes.RealtimeAdmissionTimeout ||
                (error instanceof this.sdkTypes.RimeRealtimeError &&
                  error.fault.scope !== 'session')));
          if (!known && !this.closed) this.fatal(safe);
          throw safe;
        }
      })(),
    );
  }
  /** Replace instructions and wait for provider acknowledgment. */
  updateInstructions(instructions: string): Promise<void> {
    return this.applySettings({ instructions });
  }
  /** Copy and replace function tools. Remove fillers for tools that are no longer registered. */
  updateTools(tools: llm.ToolContext): Promise<void> {
    return this.applySettings({ tools: tools.copy() });
  }
  /** Copy provider settings and persist each acknowledged change to this model's settings. */
  updateSession(options: SessionOptions): Promise<void> {
    return this.applySettings(structuredClone(options));
  }
  private definitions(tools = this.toolContext, fillers = this.fillers): r.ToolDefinition[] {
    const definitions = tools.flatten().map((tool) => {
      if (!llm.isFunctionTool(tool))
        throw new llm.RealtimeError('Prism accepts function tools only');
      return {
        name: tool.name,
        description: tool.description,
        parameters: llm.toJsonSchema(tool.parameters) as r.JsonObject,
        prismFiller: fillers[tool.name],
      };
    });
    if (Object.keys(fillers).some((name) => !definitions.some((tool) => tool.name === name)))
      throw new llm.RealtimeError('Prism fillers must name registered tools');
    return definitions;
  }
  private applySettings(
    options: SessionOptions & { instructions?: string; tools?: llm.ToolContext },
  ): Promise<void> {
    return this.operation(() =>
      this.settings.run(async () => {
        const sdk = this.requireSdk();
        const tools = options.tools ?? this.toolContext;
        let fillers = options.toolFillers ?? this.fillers;
        if (options.tools && !options.toolFillers)
          fillers = Object.fromEntries(
            Object.entries(fillers).filter(([name]) => tools.hasTool(name)),
          );
        const definitions =
          options.tools || options.toolFillers ? this.definitions(tools, fillers) : undefined;
        if (
          options.instructions !== undefined ||
          definitions ||
          options.voice !== undefined ||
          options.truncation !== undefined
        ) {
          await sdk.update({
            instructions: options.instructions,
            tools: definitions,
            voice: options.voice,
            truncation: options.truncation,
          });
          this.toolContext = tools;
          this.fillers = fillers;
          // The model shares these options with its session. Persist each acknowledged
          // mutation before the next request, which may fail independently.
          if (options.voice !== undefined) this.options.voice = options.voice;
          if (options.truncation !== undefined)
            this.options.truncation = structuredClone(options.truncation);
          this.options.toolFillers = structuredClone(fillers);
          this.emit('session_updated', this.sessionInfo);
        }
        if (options.responseMetadata !== undefined) {
          await sdk.setResponseMetadata(options.responseMetadata);
          this.options.responseMetadata = { ...options.responseMetadata };
          this.emit('session_updated', this.sessionInfo);
        }
      }),
    );
  }
  /** Set auto or none tool choice for future reply requests. Null restores auto. */
  updateOptions(options: { toolChoice?: llm.ToolChoice | null }): void {
    if (options.toolChoice === undefined) return;
    if (
      options.toolChoice !== null &&
      options.toolChoice !== 'auto' &&
      options.toolChoice !== 'none'
    ) {
      throw new llm.RealtimeError('Prism supports only auto or none tool choice');
    }
    this.toolChoice = options.toolChoice ?? 'auto';
  }
  /** Read completed provider history after pending edits, without changing local history. */
  getHistory(): Promise<readonly r.HistoryItem[]> {
    return this.operation(() => this.history!.getHistory());
  }
  /**
   * Copy and synchronize text and tool history. Invalid edits fail before mutation;
   * an edit that fails after a confirmed mutation closes the session.
   */
  updateChatCtx(ctx: llm.ChatContext): Promise<void> {
    // Preserve class instances while copying the caller's text/tool context.
    const copy = ctx.copy();
    copy.items = copy.items.map((item) => {
      if (item.type === 'message')
        return new llm.ChatMessage({ ...item, content: [...item.content] });
      if (item.type === 'function_call')
        return new llm.FunctionCall({ ...item, extra: structuredClone(item.extra) });
      if (item.type === 'function_call_output') return new llm.FunctionCallOutput({ ...item });
      return item;
    });
    return this.operation(async () => {
      for (const { ref, output } of await this.history!.sync(copy)) {
        if (!output.replyRequired) continue;
        if (ref.responseId === this.latest?.responseId) this.parent = this.latest;
        else this.report = ref;
      }
    });
  }

  /** Copy PCM input into bounded send queues, with downmixing or resampling when required. */
  pushAudio(source: AudioFrame): void {
    if (this.closed || this.failure) return;
    try {
      const format = `${source.sampleRate}/${source.channels}`;
      if (format !== this.audioFormat) {
        this.audioFormat = format;
        this.resampler = undefined;
      }
      let frame = source;
      if (source.channels > 2) {
        const mono = new Int16Array(source.samplesPerChannel);
        for (let i = 0; i < mono.length; i++) {
          let sum = 0;
          for (let channel = 0; channel < source.channels; channel++)
            sum += source.data[i * source.channels + channel]!;
          mono[i] = Math.floor(sum / source.channels);
        }
        frame = new AudioFrame(mono, source.sampleRate, 1, mono.length);
      }
      let frames = [frame];
      if (![8000, 16000, 24000, 48000].includes(frame.sampleRate)) {
        this.resampler ??= new AudioResampler(frame.sampleRate, 16000, frame.channels);
        frames = this.resampler.push(frame);
      }
      for (const converted of frames) {
        let offset = 0;
        while (offset < converted.data.length) {
          let batch = this.pendingInput;
          if (
            !batch ||
            batch.length === batch.data.length ||
            batch.format.sampleRate !== converted.sampleRate ||
            batch.format.channels !== converted.channels
          ) {
            if (this.inputCount >= 100)
              throw new llm.RealtimeError('Prism input exceeds 100 queued chunks');
            // Coalesce only unsent frames, without waiting to fill a batch. Room handoff can
            // release seconds of buffered 10 ms frames in one event-loop turn.
            batch = {
              data: new Uint8Array(((converted.sampleRate * converted.channels) / 10) * 2),
              length: 0,
              format: {
                sampleRate: converted.sampleRate as 8000 | 16000 | 24000 | 48000,
                channels: converted.channels as 1 | 2,
              },
            };
            this.pendingInput = batch;
            this.inputCount++;
            const queued = batch;
            this.background(
              this.input.run(async () => {
                try {
                  await this.initialized;
                  if (this.pendingInput === queued) this.pendingInput = undefined;
                  await this.requireSdk().sendAudio({
                    data: queued.data.subarray(0, queued.length),
                    format: queued.format,
                  });
                } finally {
                  this.inputCount--;
                }
              }),
            );
          }
          const count = Math.min(
            converted.data.length - offset,
            (batch.data.length - batch.length) / 2,
          );
          const view = new DataView(batch.data.buffer);
          for (let i = 0; i < count; i++)
            view.setInt16(batch.length + i * 2, converted.data[offset + i]!, true);
          batch.length += count * 2;
          offset += count;
        }
      }
    } catch (error) {
      this.fatal(error);
    }
  }
  /** Reject manual commits because Prism requires server turn detection. */
  async commitAudio(): Promise<void> {
    throw new llm.RealtimeError('Prism commits speech through server turn detection');
  }
  /** Clear provider input after previously queued sends and before subsequent sends. */
  clearAudio(): Promise<void> {
    this.pendingInput = undefined;
    this.resampler = undefined;
    this.audioFormat = undefined;
    // Insert the clear before accepting any subsequent sends.
    return this.track(
      this.input.run(async () => {
        try {
          await this.initialized;
          await this.requireSdk().clearAudio();
        } catch (error) {
          if (!this.closed) this.fatal(error);
          throw this.normalize(error);
        }
      }),
    );
  }

  /**
   * Request a response using the current tool choice and wait for admission.
   * Cancellation also cancels a response admitted after the caller stops waiting.
   */
  generateReply(
    instructions?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PrismGenerationCreatedEvent> {
    // Snapshot before the core resets the session-level option.
    const disableTools = this.toolChoice === 'none';
    const parent = this.parent,
      report = this.report;
    this.parent = this.report = undefined;
    return this.operation(async () => {
      options.signal?.throwIfAborted();
      await this.history!.waitForUpdates();
      if (!disableTools) return this.requestReply(instructions, parent, report, options.signal);
      const created = await this.settings.run(async () => {
        options.signal?.throwIfAborted();
        const sdk = this.requireSdk();
        const restore = this.definitions();
        this.suppressTools = true;
        this.suppressionPendingAfter = sdk.info.settingsRevision ?? undefined;
        try {
          const info = await sdk.update({ tools: [] });
          this.suppressionPendingAfter = undefined;
          if (info.settingsRevision != null) {
            this.suppressedRevisions.add(info.settingsRevision);
            if (this.suppressedRevisions.size > 128) {
              const oldest = Math.min(...this.suppressedRevisions);
              this.suppressedRevisions.delete(oldest);
              this.policyFloor = oldest + 1;
            }
          }
          this.emit('session_updated', this.sessionInfo);
          // Settle admission before restoring tools, even if the caller stops waiting.
          options.signal?.throwIfAborted();
          const created = await this.requestReply(instructions, parent, report);
          if (options.signal?.aborted) {
            await this.abandon(this.generations.get(created.responseId!)!);
            options.signal.throwIfAborted();
          }
          return created;
        } finally {
          try {
            if (!this.closed) {
              await sdk.update({ tools: restore });
              this.emit('session_updated', this.sessionInfo);
            }
          } catch (error) {
            this.fatal(error);
            throw this.normalize(error);
          } finally {
            this.suppressTools = false;
            this.suppressionPendingAfter = undefined;
          }
        }
      });
      if (options.signal?.aborted) {
        await this.abandon(this.generations.get(created.responseId!)!);
        options.signal.throwIfAborted();
      }
      return created;
    });
  }
  private async requestReply(
    instruction?: string,
    parent?: r.ResponseRef,
    report?: r.ToolCallRef,
    signal?: AbortSignal,
  ): Promise<PrismGenerationCreatedEvent> {
    const sdk = this.requireSdk();
    let ref: r.ResponseRef;
    if (instruction) ref = await sdk.requestReply({ instruction, signal });
    else if (parent) {
      try {
        ref = await sdk.continueReply(parent, { signal });
      } catch (error) {
        const superseded =
          this.sdkTypes &&
          (error instanceof this.sdkTypes.RimeInputError ||
            (error instanceof this.sdkTypes.RimeRealtimeError &&
              error.fault.scope === 'event' &&
              error.fault.code === 'tool_continuation_unavailable'));
        const call = this.history!.lastCall(parent);
        if (!superseded || !call) throw error;
        ref = await sdk.requestReply({ toolCall: call, signal });
      }
    } else ref = await sdk.requestReply({ toolCall: report, signal });
    // Closure can race with the acknowledgment. Never install a waiter after teardown.
    this.requireSdk();
    const generation =
      this.generations.get(ref.responseId) ??
      (await new Promise<Generation>((resolve, reject) => {
        this.generationWaiters.set(ref.responseId, { resolve, reject });
      }));
    if (signal?.aborted) {
      await this.abandon(generation);
      signal.throwIfAborted();
    }
    return generation.event;
  }
  private async abandon(generation: Generation): Promise<void> {
    if (generation.abandoned || this.closed) return;
    generation.abandoned = true;
    this.end(generation, true);
    try {
      await this.requireSdk().cancel(generation.ref);
    } catch (error) {
      if (!this.isStale(error, 'response_cancel_not_active')) throw error;
    }
  }
  private isStale(error: unknown, code: string): boolean {
    return Boolean(
      this.sdkTypes &&
        error instanceof this.sdkTypes.RimeRealtimeError &&
        error.fault.scope === 'event' &&
        error.fault.code === code,
    );
  }
  /** Cancel the current provider response and discard its queued output. */
  async interrupt(): Promise<void> {
    const generation = this.active && this.generations.get(this.active.responseId);
    if (!generation || this.closed) return;
    // The core calls this without awaiting it. Observe failures here.
    try {
      await this.track(this.abandon(generation));
    } catch (error) {
      if (!this.closed) this.fatal(error);
    }
  }
  /** Cancel the owning response and report interrupted playback at audioEndMs milliseconds. */
  async truncate(options: {
    messageId: string;
    audioEndMs: number;
    modalities?: ('text' | 'audio')[];
    audioTranscript?: string;
  }): Promise<void> {
    if (this.closed) return;
    const generation = [...this.generations.values()].find((value) =>
      value.outputs.has(options.messageId),
    );
    const message = generation?.outputs.get(options.messageId);
    if (!generation || !message) return;
    message.discarded = true;
    message.text.discard();
    message.audio.discard();
    if (options.audioTranscript !== undefined || options.audioEndMs === 0) {
      message.playedTranscript = options.audioTranscript ?? '';
      this.history!.recordAssistant(options.messageId, message.playedTranscript);
    }
    try {
      await this.track(
        (async () => {
          await this.abandon(generation);
          await this.requireSdk().reportPlayback({
            kind: 'interrupted',
            output: message.output,
            audioEndMs: options.audioEndMs,
          });
        })(),
      );
    } catch (error) {
      if (!this.closed && !this.isStale(error, 'truncate_not_current')) this.fatal(error);
    }
  }

  private async readEvents(): Promise<void> {
    for await (const event of this.requireSdk().events) {
      if (this.closed) return;
      this.onEvent(event);
    }
    if (!this.closed) throw new llm.RealtimeError('Prism connection closed');
  }
  private onEvent(event: r.SessionEvent<r.NormalizedRealtimeFault>): void {
    const payload = event.payload;
    this.history!.observe(
      payload,
      'itemId' in payload ? this.turnStarted.get(payload.itemId) : undefined,
    );
    switch (payload.kind) {
      case 'speech.started':
        this.latest = this.parent = undefined;
        if (this.turnStarted.size >= 128)
          throw new llm.RealtimeError('Too many pending Prism input turns');
        this.turnStarted.set(payload.itemId, Date.now());
        this.emit('input_speech_started', {});
        break;
      case 'speech.stopped':
        this.emit('input_speech_stopped', {
          userTranscriptionEnabled: true,
          endReason: payload.endReason,
        });
        break;
      case 'transcript.delta': {
        const transcript = (this.transcripts.get(payload.itemId) ?? '') + payload.delta;
        if (
          transcript.length > 65536 ||
          (!this.transcripts.has(payload.itemId) && this.transcripts.size >= 128)
        )
          throw new llm.RealtimeError('Prism transcript limit exceeded');
        this.transcripts.set(payload.itemId, transcript);
        this.emit('input_audio_transcription_completed', {
          itemId: payload.itemId,
          transcript,
          isFinal: false,
          turnStartedAt: this.turnStarted.get(payload.itemId),
        });
        break;
      }
      case 'transcript.final':
        this.emit('input_audio_transcription_completed', {
          itemId: payload.itemId,
          transcript: payload.text,
          isFinal: true,
          turnStartedAt: this.turnStarted.get(payload.itemId),
        });
        this.transcripts.delete(payload.itemId);
        this.turnStarted.delete(payload.itemId);
        break;
      case 'transcript.failed':
        this.transcripts.delete(payload.itemId);
        this.turnStarted.delete(payload.itemId);
        this.emitError(new PrismError(payload.error), true);
        break;
      case 'response.started': {
        if (payload.settingsRevision != null && payload.settingsRevision < this.policyFloor)
          throw new llm.RealtimeError('Prism tool policy is no longer retained');
        if (this.generations.size >= 128) {
          const oldest = this.generations.values().next().value as Generation;
          if (!oldest.ended || this.history!.hasPendingCalls(oldest.ref))
            throw new llm.RealtimeError('Prism generation limit reached with an active response');
          this.generations.delete(oldest.ref.responseId);
        }
        const cancel = () => {
          const generation = this.generations.get(payload.response.responseId);
          if (generation && !generation.ended) this.background(this.abandon(generation));
        };
        const messages = new OutputQueue<llm.MessageGeneration>(128, cancel);
        const functions = new OutputQueue<llm.FunctionCall>(128, cancel);
        const created: PrismGenerationCreatedEvent = {
          messageStream: messages.stream,
          functionStream: functions.stream,
          responseId: payload.response.responseId,
          userInitiated: event.requestId !== null,
          metadata: { ...payload.metadata },
          inputItemIds: [...payload.inputItemIds],
          settingsRevision: payload.settingsRevision ?? null,
          providerRequestId: this.sdk!.info.requestId,
        };
        const generation: Generation = {
          ref: payload.response,
          event: created,
          messages,
          functions,
          outputs: new Map(),
          ended: false,
          abandoned: false,
          toolsDisabled:
            payload.settingsRevision != null
              ? this.suppressedRevisions.has(payload.settingsRevision) ||
                (this.suppressionPendingAfter !== undefined &&
                  payload.settingsRevision > this.suppressionPendingAfter)
              : this.suppressTools,
        };
        this.generations.set(payload.response.responseId, generation);
        this.latest = this.active = payload.response;
        this.parent = this.report = undefined;
        this.generationWaiters.get(payload.response.responseId)?.resolve(generation);
        this.generationWaiters.delete(payload.response.responseId);
        if (event.requestId === null) this.emit('generation_created', created);
        break;
      }
      case 'response.abandoned': {
        const generation = this.generations.get(payload.response.responseId);
        if (generation) this.background(this.abandon(generation));
        break;
      }
      case 'message.started': {
        const generation = this.generations.get(payload.output.response.responseId);
        if (!generation || generation.abandoned || generation.ended) return;
        if (generation.outputs.size >= 128)
          throw new llm.RealtimeError('Prism output record limit exceeded');
        const cancel = () => {
          if (!generation.ended) this.background(this.abandon(generation));
        };
        const message: Message = {
          output: payload.output,
          text: new OutputQueue(256, cancel),
          audio: new OutputQueue(256, cancel),
          transcript: '',
          discarded: false,
        };
        generation.outputs.set(payload.output.itemId, message);
        generation.messages.push({
          messageId: payload.output.itemId,
          textStream: message.text.stream,
          audioStream: message.audio.stream,
          modalities: Promise.resolve(['text', 'audio']),
        });
        break;
      }
      case 'text.delta':
      case 'text.done':
      case 'audio.delta':
      case 'audio.done': {
        const generation = this.generations.get(payload.output.response.responseId);
        const message = generation?.outputs.get(payload.output.itemId);
        if (
          !generation ||
          generation.abandoned ||
          generation.ended ||
          !message ||
          message.discarded
        )
          return;
        if (payload.kind === 'text.delta') {
          message.transcript += payload.delta;
          if (message.transcript.length > 65536)
            throw new llm.RealtimeError('Prism text limit exceeded');
          message.text.push(payload.delta);
        } else if (payload.kind === 'text.done') {
          if (payload.text.length > 65536) throw new llm.RealtimeError('Prism text limit exceeded');
          if (!message.transcript && payload.text) message.text.push(payload.text);
          message.transcript = payload.text;
          message.text.close();
        } else if (payload.kind === 'audio.delta') {
          const data = payload.audio.data;
          if (data.length) {
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const samples = new Int16Array(data.length / 2);
            for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
            message.audio.push(new AudioFrame(samples, 24000, 1, samples.length));
          }
        } else message.audio.close();
        break;
      }
      case 'tool.call': {
        const generation = this.generations.get(payload.call.responseId);
        if (!generation || generation.abandoned || generation.ended) return;
        if (generation.toolsDisabled)
          throw new llm.RealtimeError('Prism emitted a tool during a tool-disabled reply');
        generation.functions.push(this.history!.recordToolCall(payload));
        break;
      }
      case 'response.ended': {
        const generation = this.generations.get(payload.response.responseId);
        if (generation) this.end(generation, payload.status !== 'completed');
        if (this.active?.responseId === payload.response.responseId) this.active = undefined;
        if (payload.status === 'failed')
          this.emitError(new llm.RealtimeError('Prism response failed'), true);
        break;
      }
      case 'error':
        if (payload.error.scope === 'session') this.fatal(new PrismError(payload.error));
        else if (payload.error.requestId === null)
          this.emitError(new PrismError(payload.error), true);
        break;
    }
  }
  private end(generation: Generation, discard = false): void {
    if (generation.ended && !discard) return;
    const alreadyEnded = generation.ended;
    generation.ended = true;
    for (const [id, message] of generation.outputs) {
      if (!alreadyEnded)
        this.history?.recordAssistant(id, message.playedTranscript ?? message.transcript);
      if (discard) {
        message.text.discard();
        message.audio.discard();
      } else {
        message.text.close();
        message.audio.close();
      }
    }
    if (discard) {
      generation.messages.discard();
      generation.functions.discard();
    } else {
      generation.messages.close();
      generation.functions.close();
    }
  }
  private emitError(error: llm.RealtimeError, recoverable: boolean): void {
    // EventEmitter throws for unhandled 'error'; direct users can inspect rejected operations.
    if (this.listenerCount('error'))
      this.emit('error', {
        type: 'realtime_model_error',
        timestamp: Date.now(),
        label: this.realtimeModel.label(),
        error,
        recoverable,
        retryable: error instanceof PrismError ? error.retryable : false,
      } satisfies llm.RealtimeModelError & { retryable: boolean });
  }
  private fatal(error: unknown): void {
    if (this.failure || this.closed) return;
    this.failure = this.normalize(error);
    this.emitError(this.failure, false);
    void this.close().catch(() => undefined);
  }
  /** Settle pending work and close session resources. Leave a caller-owned SDK client open. */
  override close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifetime.abort();
    for (const waiter of this.generationWaiters.values())
      waiter.reject(this.failure ?? new llm.RealtimeError('Prism session closed'));
    this.generationWaiters.clear();
    for (const generation of this.generations.values()) this.end(generation, true);
    this.closing = (async () => {
      await this.initialized.catch(() => undefined);
      const cleanup = await Promise.allSettled([
        this.sdk?.close(),
        super.close(),
        this.options.client ? undefined : this.client?.close(),
      ]);
      await Promise.allSettled([...this.tasks]);
      this.generations.clear();
      this.turnStarted.clear();
      this.transcripts.clear();
      this.pendingInput = undefined;
      this.resampler = undefined;
      this.fullyClosed = true;
      const failed = cleanup.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw this.failure ?? this.normalize(failed.reason);
    })();
    return this.closing;
  }
}
