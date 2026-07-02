// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Mutex } from '@livekit/mutex';
import type { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { log } from '../log.js';
import type { AgentSession } from '../voice/agent_session.js';
import type { ChatContext } from './chat_context.js';
import {
  type GenerationCreatedEvent,
  type RealtimeCapabilities,
  RealtimeModel,
  type RealtimeModelError,
  RealtimeSession,
} from './realtime.js';
import type { ToolChoice, ToolContext } from './tool_context.js';

const HARD_CAPABILITIES = ['audioOutput', 'turnDetection'] as const;
const SOFT_CAPABILITIES = [
  'messageTruncation',
  'userTranscription',
  'manualFunctionCalls',
  'autoToolReplyGeneration',
  'midSessionChatCtxUpdate',
  'midSessionInstructionsUpdate',
  'midSessionToolsUpdate',
  'perResponseToolChoice',
  'nativeTranscriptSync',
] as const;

const FORWARDED_EVENTS = [
  'input_speech_started',
  'input_speech_stopped',
  'input_audio_transcription_completed',
  'generation_created',
  'session_reconnected',
  'metrics_collected',
] as const;

export interface RealtimeAvailabilityChangedEvent {
  realtimeModel: RealtimeModel;
  available: boolean;
}

export interface RealtimeModelFallbackAdapterOptions {
  /** Ordered models; first is primary and the rest are fallbacks. */
  models: RealtimeModel[];
  /** Milliseconds a failed model stays unavailable before it can be preferred again. */
  cooldown?: number;
  /** Re-issue the reply on the new session if one was in progress. */
  regenerateOnSwap?: boolean;
}

function mergeCapabilities(models: RealtimeModel[]): RealtimeCapabilities {
  const first = models[0]!.capabilities;
  for (const model of models.slice(1)) {
    const caps = model.capabilities;
    for (const name of HARD_CAPABILITIES) {
      if (caps[name] !== first[name]) {
        throw new Error(
          `all realtime models must agree on \`${name}\` to be used in a ` +
            `RealtimeModelFallbackAdapter, got ${first[name]} and ${caps[name]}`,
        );
      }
    }
  }

  const merged: RealtimeCapabilities = {
    audioOutput: first.audioOutput,
    turnDetection: first.turnDetection,
    messageTruncation: true,
    userTranscription: true,
    manualFunctionCalls: true,
    autoToolReplyGeneration: true,
  };

  for (const name of SOFT_CAPABILITIES) {
    merged[name] = models.every((model) => !!model.capabilities[name]);
  }

  return merged;
}

export class RealtimeModelFallbackAdapter extends RealtimeModel {
  readonly models: RealtimeModel[];
  readonly cooldown: number;
  readonly regenerateOnSwap: boolean;
  readonly sessions = new Set<FallbackRealtimeSession>();
  private eventEmitter = new EventEmitter();

  constructor(options: RealtimeModelFallbackAdapterOptions) {
    if (!options.models || options.models.length < 1) {
      throw new Error('at least one RealtimeModel instance must be provided.');
    }

    super(mergeCapabilities(options.models));
    this.models = options.models;
    this.cooldown = options.cooldown ?? 10000;
    this.regenerateOnSwap = options.regenerateOnSwap ?? true;
  }

  get model(): string {
    return 'RealtimeModelFallbackAdapter';
  }

  override get provider(): string {
    return 'livekit';
  }

  override label(): string {
    return 'RealtimeModelFallbackAdapter';
  }

  session(): FallbackRealtimeSession {
    const session = new FallbackRealtimeSession(this);
    this.sessions.add(session);
    session.once('close', () => this.sessions.delete(session));
    return session;
  }

  async restartSession(options: { switchModel?: boolean } = {}): Promise<void> {
    await Promise.all(
      [...this.sessions].map((session) => session.restart({ switchModel: !!options.switchModel })),
    );
  }

  async close(): Promise<void> {
    await Promise.all(this.models.map((model) => model.close()));
  }

  on(
    event: 'realtime_availability_changed',
    listener: (ev: RealtimeAvailabilityChangedEvent) => void,
  ): this {
    this.eventEmitter.on(event, listener);
    return this;
  }

  off(
    event: 'realtime_availability_changed',
    listener: (ev: RealtimeAvailabilityChangedEvent) => void,
  ): this {
    this.eventEmitter.off(event, listener);
    return this;
  }

  emit(event: 'realtime_availability_changed', ev: RealtimeAvailabilityChangedEvent): boolean {
    return this.eventEmitter.emit(event, ev);
  }
}

export class FallbackRealtimeSession extends RealtimeSession {
  private adapter: RealtimeModelFallbackAdapter;
  private instructions?: string;
  private toolsState?: ToolContext;
  private toolChoice: ToolChoice | null | undefined;
  private activeIndex = 0;
  private active: RealtimeSession;
  private available: boolean[];
  private cooldownDeadline: number[];
  private swapTask?: Promise<void>;
  private swapLock = new Mutex();
  private agentSession?: AgentSession;
  private swapping = false;
  private fallbackLogger = log();
  private forwarders = new Map<string, (ev: unknown) => void>();

  constructor(adapter: RealtimeModelFallbackAdapter) {
    super(adapter);
    this.adapter = adapter;
    this.available = adapter.models.map(() => true);
    this.cooldownDeadline = adapter.models.map(() => 0);
    this.active = adapter.models[0]!.session();

    for (const event of FORWARDED_EVENTS) {
      this.forwarders.set(event, (ev: unknown) => this.emit(event, ev));
    }
    this.bind(this.active);
  }

  /** @internal */
  _bindAgentSession(agentSession?: AgentSession): void {
    this.agentSession = agentSession;
  }

  private bind(child: RealtimeSession): void {
    for (const [event, forwarder] of this.forwarders) {
      child.on(event, forwarder);
    }
    child.on('error', this.onChildError);
  }

  private unbind(child: RealtimeSession): void {
    for (const [event, forwarder] of this.forwarders) {
      child.off(event, forwarder);
    }
    child.off('error', this.onChildError);
  }

  private setAvailable(index: number, available: boolean): void {
    if (this.available[index] === available) return;
    this.available[index] = available;
    if (!available) {
      this.cooldownDeadline[index] = Date.now() + this.adapter.cooldown;
    }
    this.adapter.emit('realtime_availability_changed', {
      realtimeModel: this.adapter.models[index]!,
      available,
    } satisfies RealtimeAvailabilityChangedEvent);
  }

  private nextAvailableIndex(options: { excludeCurrent?: boolean } = {}): number | undefined {
    const now = Date.now();
    for (const [index, deadline] of this.cooldownDeadline.entries()) {
      if (!this.available[index] && deadline <= now) {
        this.setAvailable(index, true);
      }
    }

    for (let i = 0; i < this.adapter.models.length; i++) {
      if (options.excludeCurrent && i === this.activeIndex) continue;
      if (this.available[i]) return i;
    }
    return undefined;
  }

  private isAgentSpeaking(): boolean {
    return (
      this.agentSession?.agentState === 'speaking' || this.agentSession?.agentState === 'thinking'
    );
  }

  private onChildError = (error: RealtimeModelError): void => {
    if (error.recoverable) {
      this.emit('error', error);
      return;
    }

    this.setAvailable(this.activeIndex, false);
    const target = this.nextAvailableIndex();
    if (target === undefined) {
      this.emit('error', error);
      return;
    }

    this.emit('error', { ...error, recoverable: true } satisfies RealtimeModelError);
    if (!this.swapTask) {
      const wasSpeaking = this.isAgentSpeaking();
      this.swapTask = this.swap(target, wasSpeaking).finally(() => {
        this.swapTask = undefined;
      });
    }
  };

  async restart(options: { switchModel: boolean }): Promise<void> {
    let target = this.activeIndex;
    if (options.switchModel) {
      target = this.nextAvailableIndex({ excludeCurrent: true }) ?? this.activeIndex;
    }
    await this.swap(target, this.isAgentSpeaking());
  }

  private async swap(targetIndex: number, wasSpeaking: boolean): Promise<void> {
    const unlock = await this.swapLock.lock();
    try {
      if (this.agentSession) {
        try {
          await this.agentSession.interrupt({ force: true }).await;
        } catch (error) {
          this.fallbackLogger.debug(
            { error },
            'failed to interrupt the agent before realtime swap',
          );
        }
      }

      const chatCtx = this.agentSession?.currentAgent.chatCtx ?? this.active.chatCtx;

      const bringUp = async (index: number): Promise<Error | undefined> => {
        try {
          this.active = this.adapter.models[index]!.session();
          this.activeIndex = index;
          this.bind(this.active);
          await this.active._updateSession(this.instructions, chatCtx, this.toolsState);
          if (this.toolChoice !== undefined) {
            this.active.updateOptions({ toolChoice: this.toolChoice });
          }
          return undefined;
        } catch (error) {
          this.fallbackLogger.error(
            { error },
            'failed to start realtime model on swap, trying next',
          );
          this.unbind(this.active);
          await this.active.close().catch(() => undefined);
          this.setAvailable(index, false);
          return error instanceof Error ? error : new Error(String(error));
        }
      };

      this.swapping = true;
      let error: Error | undefined;
      try {
        this.unbind(this.active);
        await this.active.close().catch(() => undefined);

        error = await bringUp(targetIndex);
        while (error) {
          const next = this.nextAvailableIndex();
          if (next === undefined) break;
          error = await bringUp(next);
        }
      } finally {
        this.swapping = false;
      }

      if (error) {
        this.emit('error', {
          type: 'realtime_model_error',
          timestamp: Date.now(),
          label: this.adapter.label(),
          error,
          recoverable: false,
        } satisfies RealtimeModelError);
        return;
      }

      this.emit('session_reconnected', {});
      if (wasSpeaking && this.adapter.regenerateOnSwap && this.agentSession) {
        this.agentSession.generateReply();
      }
    } finally {
      unlock();
    }
  }

  override get capabilities(): RealtimeCapabilities {
    return this.active.realtimeModel.capabilities;
  }

  get chatCtx(): ChatContext {
    return this.active.chatCtx;
  }

  get tools(): ToolContext {
    return this.active.tools;
  }

  async updateInstructions(instructions: string): Promise<void> {
    this.instructions = instructions;
    await this.active.updateInstructions(instructions);
  }

  async updateChatCtx(chatCtx: ChatContext): Promise<void> {
    if (this.swapping) return;
    await this.active.updateChatCtx(chatCtx);
  }

  async updateTools(tools: ToolContext): Promise<void> {
    this.toolsState = tools;
    await this.active.updateTools(tools);
  }

  updateOptions(options: { toolChoice?: ToolChoice | null }): void {
    if ('toolChoice' in options) {
      this.toolChoice = options.toolChoice;
    }
    this.active.updateOptions(options);
  }

  pushAudio(frame: AudioFrame): void {
    if (this.swapping) return;
    this.active.pushAudio(frame);
  }

  generateReply(
    instructions?: string,
    options?: { signal?: AbortSignal },
  ): Promise<GenerationCreatedEvent> {
    return this.active.generateReply(instructions, options);
  }

  commitAudio(): Promise<void> {
    return this.active.commitAudio();
  }

  clearAudio(): Promise<void> {
    return this.active.clearAudio();
  }

  interrupt(): Promise<void> {
    return this.active.interrupt();
  }

  startUserActivity(): void {
    this.active.startUserActivity();
  }

  truncate(options: {
    messageId: string;
    audioEndMs: number;
    modalities?: ('text' | 'audio')[];
    audioTranscript?: string;
  }): Promise<void> {
    return this.active.truncate(options);
  }

  override async close(): Promise<void> {
    this.agentSession = undefined;
    await this.swapTask?.catch(() => undefined);
    this.unbind(this.active);
    await this.active.close();
    this.emit('close');
    await super.close();
  }
}
