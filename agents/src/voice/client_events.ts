// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room, RpcInvocationData, TextStreamInfo, TextStreamReader } from '@livekit/rtc-node';
import type { TypedEventEmitter } from '@livekit/typed-emitter';
import EventEmitter from 'events';
import type { z } from 'zod';
import {
  RPC_GET_AGENT_INFO,
  RPC_GET_CHAT_HISTORY,
  RPC_GET_SESSION_STATE,
  RPC_SEND_MESSAGE,
  TOPIC_AGENT_REQUEST,
  TOPIC_AGENT_RESPONSE,
  TOPIC_CHAT,
  TOPIC_CLIENT_EVENTS,
} from '../constants.js';
import type { OverlappingSpeechEvent } from '../inference/interruption/types.js';
import type { ToolContext } from '../llm/tool_context.js';
import { log } from '../log.js';
import { Future, Task, cancelAndWait, shortuuid } from '../utils.js';
import type { AgentSession } from './agent_session.js';
import {
  AgentSessionEventTypes,
  type AgentStateChangedEvent,
  type ConversationItemAddedEvent,
  type ErrorEvent,
  type FunctionToolsExecutedEvent,
  type MetricsCollectedEvent,
  type UserInputTranscribedEvent,
  type UserStateChangedEvent,
} from './events.js';
import type { RoomIO } from './room_io/room_io.js';
import {
  agentMetricsToWire,
  agentSessionUsageToWire,
  chatItemToWire,
  chatMessageToWire,
  type clientAgentStateChangedSchema,
  type clientConversationItemAddedSchema,
  type clientErrorSchema,
  clientEventSchema,
  type clientFunctionToolsExecutedSchema,
  type clientMetricsCollectedSchema,
  type clientSessionUsageSchema,
  type clientUserInputTranscribedSchema,
  type clientUserOverlappingSpeechSchema,
  type clientUserStateChangedSchema,
  functionCallOutputToWire,
  functionCallToWire,
  getAgentInfoResponseSchema,
  getChatHistoryResponseSchema,
  getRTCStatsResponseSchema,
  getSessionStateResponseSchema,
  getSessionUsageResponseSchema,
  msToS,
  sendMessageRequestSchema,
  sendMessageResponseSchema,
  streamRequestSchema,
  streamResponseSchema,
} from './wire_format.js';

/** @experimental */
export type ClientAgentStateChangedEvent = z.infer<typeof clientAgentStateChangedSchema>;

/** @experimental */
export type ClientUserStateChangedEvent = z.infer<typeof clientUserStateChangedSchema>;

/** @experimental */
export type ClientConversationItemAddedEvent = z.infer<typeof clientConversationItemAddedSchema>;

/** @experimental */
export type ClientUserInputTranscribedEvent = z.infer<typeof clientUserInputTranscribedSchema>;

/** @experimental */
export type ClientFunctionToolsExecutedEvent = z.infer<typeof clientFunctionToolsExecutedSchema>;

/** @experimental */
export type ClientMetricsCollectedEvent = z.infer<typeof clientMetricsCollectedSchema>;

/** @experimental */
export type ClientErrorEvent = z.infer<typeof clientErrorSchema>;

/** @experimental */
export type ClientUserOverlappingSpeechEvent = z.infer<typeof clientUserOverlappingSpeechSchema>;

/** @experimental */
export type ClientSessionUsageEvent = z.infer<typeof clientSessionUsageSchema>;

/** @experimental */
export type ClientEvent = z.infer<typeof clientEventSchema>;

/** @experimental */
export type ClientEventType = ClientEvent['type'];

/** @experimental */
export type StreamRequest = z.infer<typeof streamRequestSchema>;

/** @experimental */
export type StreamResponse = z.infer<typeof streamResponseSchema>;

/** @experimental */
export type GetSessionStateRequest = Record<string, never>;

/** @experimental */
export type GetSessionStateResponse = z.infer<typeof getSessionStateResponseSchema>;

/** @experimental */
export type GetChatHistoryRequest = Record<string, never>;

/** @experimental */
export type GetChatHistoryResponse = z.infer<typeof getChatHistoryResponseSchema>;

/** @experimental */
export type GetAgentInfoRequest = Record<string, never>;

/** @experimental */
export type GetAgentInfoResponse = z.infer<typeof getAgentInfoResponseSchema>;

/** @experimental */
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

/** @experimental */
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

/** @experimental */
export type GetRTCStatsRequest = Record<string, never>;

/** @experimental */
export type GetRTCStatsResponse = z.infer<typeof getRTCStatsResponseSchema>;

/** @experimental */
export type GetSessionUsageRequest = Record<string, never>;

/** @experimental */
export type GetSessionUsageResponse = z.infer<typeof getSessionUsageResponseSchema>;

function serializeOptions(opts: {
  turnHandling?: {
    endpointing?: unknown;
    interruption?: unknown;
  };
  maxToolSteps?: number;
  userAwayTimeout?: number | null;
  preemptiveGeneration?: boolean;
  useTtsAlignedTranscript?: boolean;
}): Record<string, unknown> {
  return {
    endpointing: opts.turnHandling?.endpointing ?? {},
    interruption: opts.turnHandling?.interruption ?? {},
    max_tool_steps: opts.maxToolSteps,
    user_away_timeout: opts.userAwayTimeout,
    preemptive_generation: opts.preemptiveGeneration,
    use_tts_aligned_transcript: opts.useTtsAlignedTranscript,
  };
}

function toolNames(toolCtx: ToolContext | undefined): string[] {
  if (!toolCtx) return [];
  return Object.keys(toolCtx);
}

/** @experimental */
export type RemoteSessionEventTypes =
  | 'agent_state_changed'
  | 'user_state_changed'
  | 'conversation_item_added'
  | 'user_input_transcribed'
  | 'function_tools_executed'
  | 'metrics_collected'
  | 'user_overlapping_speech'
  | 'session_usage'
  | 'error';

/** @experimental */
export type RemoteSessionCallbacks = {
  agent_state_changed: (ev: ClientAgentStateChangedEvent) => void;
  user_state_changed: (ev: ClientUserStateChangedEvent) => void;
  conversation_item_added: (ev: ClientConversationItemAddedEvent) => void;
  user_input_transcribed: (ev: ClientUserInputTranscribedEvent) => void;
  function_tools_executed: (ev: ClientFunctionToolsExecutedEvent) => void;
  metrics_collected: (ev: ClientMetricsCollectedEvent) => void;
  user_overlapping_speech: (ev: ClientUserOverlappingSpeechEvent) => void;
  session_usage: (ev: ClientSessionUsageEvent) => void;
  error: (ev: ClientErrorEvent) => void;
};

export interface TextInputEvent {
  text: string;
  info: TextStreamInfo;
  participantIdentity: string;
}

export type TextInputCallback = (session: AgentSession, ev: TextInputEvent) => void | Promise<void>;

/**
 * Handles exposing AgentSession state to room participants and allows interaction.
 *
 * This class provides:
 * - Event streaming: Automatically streams AgentSession events to clients via a text stream
 * - RPC handlers: Allows clients to request state, chat history, and agent info on demand
 * - Text input handling: Receives text messages from clients and generates agent replies
 */

/** @experimental */
export class ClientEventsHandler {
  private readonly session: AgentSession;
  private readonly roomIO: RoomIO;

  private textInputCb?: TextInputCallback;
  private textStreamHandlerRegistered = false;
  private rpcHandlersRegistered = false;
  private requestHandlerRegistered = false;
  private eventHandlersRegistered = false;
  private started = false;

  private readonly tasks = new Set<Task<void>>();
  private readonly logger = log();

  constructor(session: AgentSession, roomIO: RoomIO) {
    this.session = session;
    this.roomIO = roomIO;
  }

  private get room(): Room {
    return this.roomIO.rtcRoom;
  }

  async start(): Promise<void> {
    if (this.started) return;

    this.started = true;
    this.registerRpcHandlers();
    this.registerRequestHandler();
    this.registerEventHandlers();
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.textStreamHandlerRegistered) {
      this.room.unregisterTextStreamHandler(TOPIC_CHAT);
      this.textStreamHandlerRegistered = false;
    }

    if (this.rpcHandlersRegistered) {
      const localParticipant = this.room.localParticipant;
      if (localParticipant) {
        localParticipant.unregisterRpcMethod(RPC_GET_SESSION_STATE);
        localParticipant.unregisterRpcMethod(RPC_GET_CHAT_HISTORY);
        localParticipant.unregisterRpcMethod(RPC_GET_AGENT_INFO);
        localParticipant.unregisterRpcMethod(RPC_SEND_MESSAGE);
      }
      this.rpcHandlersRegistered = false;
    }

    if (this.requestHandlerRegistered) {
      this.room.unregisterTextStreamHandler(TOPIC_AGENT_REQUEST);
      this.requestHandlerRegistered = false;
    }

    if (this.eventHandlersRegistered) {
      this.session.off(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);
      this.session.off(AgentSessionEventTypes.UserStateChanged, this.onUserStateChanged);
      this.session.off(AgentSessionEventTypes.ConversationItemAdded, this.onConversationItemAdded);
      this.session.off(AgentSessionEventTypes.FunctionToolsExecuted, this.onFunctionToolsExecuted);
      this.session.off(AgentSessionEventTypes.MetricsCollected, this.onMetricsCollected);
      this.session.off(AgentSessionEventTypes.UserInputTranscribed, this.onUserInputTranscribed);
      this.session.off(AgentSessionEventTypes.UserOverlappingSpeech, this.onUserOverlapSpeech);
      this.session.off(AgentSessionEventTypes.Error, this.onError);
      this.eventHandlersRegistered = false;
    }

    await cancelAndWait([...this.tasks]);
    this.tasks.clear();
  }

  /**
   * Registers a callback to handle text input from clients.
   *
   * This callback will be called when a client sends a text message to the agent.
   * The callback should return a promise that resolves when the text input has been processed.
   *
   * @param textInputCb - The callback to handle text input.
   */
  registerTextInput(textInputCb: TextInputCallback): void {
    this.textInputCb = textInputCb;
    if (this.textStreamHandlerRegistered) return;
    this.room.registerTextStreamHandler(TOPIC_CHAT, this.onUserTextInput);
    this.textStreamHandlerRegistered = true;
  }

  private registerRpcHandlers(): void {
    if (this.rpcHandlersRegistered) return;

    const localParticipant = this.room.localParticipant;
    if (!localParticipant) return;

    localParticipant.registerRpcMethod(RPC_GET_SESSION_STATE, this.rpcGetSessionState);
    localParticipant.registerRpcMethod(RPC_GET_CHAT_HISTORY, this.rpcGetChatHistory);
    localParticipant.registerRpcMethod(RPC_GET_AGENT_INFO, this.rpcGetAgentInfo);
    localParticipant.registerRpcMethod(RPC_SEND_MESSAGE, this.rpcSendMessage);
    this.rpcHandlersRegistered = true;
  }

  private registerRequestHandler(): void {
    if (this.requestHandlerRegistered) return;

    this.room.registerTextStreamHandler(TOPIC_AGENT_REQUEST, this.onStreamRequest);
    this.requestHandlerRegistered = true;
  }

  private registerEventHandlers(): void {
    if (this.eventHandlersRegistered) return;

    this.session.on(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);
    this.session.on(AgentSessionEventTypes.UserStateChanged, this.onUserStateChanged);
    this.session.on(AgentSessionEventTypes.ConversationItemAdded, this.onConversationItemAdded);
    this.session.on(AgentSessionEventTypes.FunctionToolsExecuted, this.onFunctionToolsExecuted);
    this.session.on(AgentSessionEventTypes.MetricsCollected, this.onMetricsCollected);
    this.session.on(AgentSessionEventTypes.UserInputTranscribed, this.onUserInputTranscribed);
    this.session.on(AgentSessionEventTypes.UserOverlappingSpeech, this.onUserOverlapSpeech);
    this.session.on(AgentSessionEventTypes.Error, this.onError);
    this.eventHandlersRegistered = true;
  }

  private onStreamRequest = (
    reader: TextStreamReader,
    participantInfo: { identity: string },
  ): void => {
    const task = Task.from(async () => this.handleStreamRequest(reader, participantInfo.identity));
    this.trackTask(task);
  };

  private async handleStreamRequest(
    reader: TextStreamReader,
    participantIdentity: string,
  ): Promise<void> {
    try {
      const data = await reader.readAll();
      const request = streamRequestSchema.parse(JSON.parse(data));

      let responsePayload = '';
      let error: string | null = null;

      try {
        switch (request.method) {
          case 'get_session_state':
            responsePayload = await this.streamGetSessionState();
            break;
          case 'get_chat_history':
            responsePayload = await this.streamGetChatHistory();
            break;
          case 'get_agent_info':
            responsePayload = await this.streamGetAgentInfo();
            break;
          case 'send_message':
            responsePayload = await this.streamSendMessage(request.payload);
            break;
          case 'get_rtc_stats':
            responsePayload = await this.streamGetRtcStats();
            break;
          case 'get_session_usage':
            responsePayload = await this.streamGetSessionUsage();
            break;
          default:
            error = `Unknown method: ${request.method}`;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      const response: StreamResponse = {
        request_id: request.request_id,
        payload: responsePayload,
        error,
      };

      const localParticipant = this.room.localParticipant;
      await localParticipant!.sendText(JSON.stringify(response), {
        topic: TOPIC_AGENT_RESPONSE,
        destinationIdentities: [participantIdentity],
      });
    } catch (e) {
      this.logger.warn({ error: e }, 'failed to handle stream request');
    }
  }

  private async streamGetSessionState(): Promise<string> {
    const agent = this.session.currentAgent;

    const response: GetSessionStateResponse = {
      agent_state: this.session.agentState,
      user_state: this.session.userState,
      agent_id: agent.id,
      options: serializeOptions({
        turnHandling: this.session.sessionOptions.turnHandling,
        maxToolSteps: this.session.sessionOptions.maxToolSteps,
        userAwayTimeout: this.session.sessionOptions.userAwayTimeout,
        preemptiveGeneration: this.session.sessionOptions.preemptiveGeneration,
        useTtsAlignedTranscript: this.session.sessionOptions.useTtsAlignedTranscript,
      }),
      created_at: msToS(this.session._startedAt ?? Date.now()),
    };
    return JSON.stringify(response);
  }

  private async streamGetChatHistory(): Promise<string> {
    return JSON.stringify({
      items: this.session.history.items.map(chatItemToWire),
    });
  }

  private async streamGetAgentInfo(): Promise<string> {
    const agent = this.session.currentAgent;
    return JSON.stringify({
      id: agent.id,
      instructions: agent.instructions,
      tools: toolNames(agent.toolCtx),
      chat_ctx: agent.chatCtx.items.map(chatItemToWire),
    });
  }

  private async streamSendMessage(payload: string): Promise<string> {
    const request = sendMessageRequestSchema.parse(JSON.parse(payload));
    const runResult = this.session.run({ userInput: request.text });
    await runResult.wait();
    return JSON.stringify({
      items: runResult.events.map((ev) => chatItemToWire(ev.item)),
    });
  }

  private async streamGetRtcStats(): Promise<string> {
    // TODO(parity): map rtc stats fields once getRtcStats API shape is finalized in rtc-node.
    return JSON.stringify({
      publisher_stats: [],
      subscriber_stats: [],
    });
  }

  private async streamGetSessionUsage(): Promise<string> {
    return JSON.stringify({
      usage: agentSessionUsageToWire(this.session.usage),
      created_at: msToS(Date.now()),
    });
  }

  private onUserOverlapSpeech = (event: OverlappingSpeechEvent): void => {
    const clientEvent: ClientUserOverlappingSpeechEvent = {
      type: 'user_overlapping_speech',
      is_interruption: event.isInterruption,
      created_at: msToS(event.timestamp),
      overlap_started_at: event.overlapStartedAt != null ? msToS(event.overlapStartedAt) : null,
      detection_delay: event.detectionDelayInS,
      sent_at: msToS(Date.now()),
    };
    this.streamClientEvent(clientEvent);
  };

  private onAgentStateChanged = (event: AgentStateChangedEvent): void => {
    const clientEvent: ClientAgentStateChangedEvent = {
      type: 'agent_state_changed',
      old_state: event.oldState,
      new_state: event.newState,
      created_at: msToS(event.createdAt),
    };
    this.streamClientEvent(clientEvent);
  };

  private onUserStateChanged = (event: UserStateChangedEvent): void => {
    const clientEvent: ClientUserStateChangedEvent = {
      type: 'user_state_changed',
      old_state: event.oldState,
      new_state: event.newState,
      created_at: msToS(event.createdAt),
    };
    this.streamClientEvent(clientEvent);
  };

  private onConversationItemAdded = (event: ConversationItemAddedEvent): void => {
    if (event.item.type !== 'message') {
      return;
    }
    this.streamClientEvent({
      type: 'conversation_item_added',
      item: chatMessageToWire(event.item) as ClientConversationItemAddedEvent['item'],
      created_at: msToS(event.createdAt),
    });
  };

  private onUserInputTranscribed = (event: UserInputTranscribedEvent): void => {
    this.streamClientEvent({
      type: 'user_input_transcribed',
      transcript: event.transcript,
      is_final: event.isFinal,
      language: event.language,
      created_at: msToS(event.createdAt),
    });
  };

  private onFunctionToolsExecuted = (event: FunctionToolsExecutedEvent): void => {
    this.streamClientEvent({
      type: 'function_tools_executed',
      function_calls: event.functionCalls.map(
        functionCallToWire,
      ) as ClientFunctionToolsExecutedEvent['function_calls'],
      function_call_outputs: event.functionCallOutputs.map((o) =>
        o
          ? (functionCallOutputToWire(o) as NonNullable<
              ClientFunctionToolsExecutedEvent['function_call_outputs'][number]
            >)
          : null,
      ),
      created_at: msToS(event.createdAt),
    });
  };

  private onMetricsCollected = (event: MetricsCollectedEvent): void => {
    this.streamClientEvent({
      type: 'metrics_collected',
      metrics: agentMetricsToWire(event.metrics) as ClientMetricsCollectedEvent['metrics'],
      created_at: msToS(event.createdAt),
    });

    this.streamClientEvent({
      type: 'session_usage',
      usage: agentSessionUsageToWire(this.session.usage) as ClientSessionUsageEvent['usage'],
      created_at: msToS(Date.now()),
    });
  };

  private onError = (event: ErrorEvent): void => {
    const clientEvent: ClientErrorEvent = {
      type: 'error',
      message: event.error ? String(event.error) : 'Unknown error',
      created_at: msToS(event.createdAt),
    };
    this.streamClientEvent(clientEvent);
  };

  private getTargetIdentities(): string[] | null {
    const linked = this.roomIO.linkedParticipant;

    // TODO(permissions): check linked.permissions.can_subscribe_metrics
    return linked ? [linked.identity] : null;
  }

  private streamClientEvent(event: ClientEvent): void {
    const task = Task.from(async () => this.sendClientEvent(event));
    this.trackTask(task);
  }

  private async sendClientEvent(event: ClientEvent): Promise<void> {
    if (!this.room.isConnected) return;

    const destinationIdentities = this.getTargetIdentities();
    if (!destinationIdentities) return;

    try {
      const localParticipant = this.room.localParticipant;
      if (!localParticipant) return;

      const writer = await localParticipant.streamText({
        topic: TOPIC_CLIENT_EVENTS,
        destinationIdentities,
      });
      await writer.write(JSON.stringify(event));
      await writer.close();
    } catch (e) {
      this.logger.warn({ error: e }, 'failed to stream event to clients');
    }
  }

  private rpcGetSessionState = async (): Promise<string> => {
    return this.streamGetSessionState();
  };

  private rpcGetChatHistory = async (): Promise<string> => {
    return this.streamGetChatHistory();
  };

  private rpcGetAgentInfo = async (): Promise<string> => {
    return this.streamGetAgentInfo();
  };

  private rpcSendMessage = async (data: RpcInvocationData): Promise<string> => {
    return this.streamSendMessage(data.payload);
  };

  private onUserTextInput = (
    reader: TextStreamReader,
    participantInfo: { identity: string },
  ): void => {
    const linkedParticipant = this.roomIO.linkedParticipant;
    if (linkedParticipant && participantInfo.identity !== linkedParticipant.identity) {
      return;
    }

    const participant = this.room.remoteParticipants.get(participantInfo.identity);
    if (!participant) {
      this.logger.warn('participant not found, ignoring text input');
      return;
    }

    if (!this.textInputCb) {
      this.logger.error('text input callback is not set, ignoring text input');
      return;
    }

    const task = Task.from(async () => {
      const text = await reader.readAll();
      const result = this.textInputCb!(this.session, {
        text,
        info: reader.info,
        participantIdentity: participantInfo.identity,
      });

      if (result instanceof Promise) {
        await result;
      }
    });

    this.trackTask(task);
  };

  private trackTask(task: Task<void>): void {
    this.tasks.add(task);
    task.addDoneCallback(() => {
      this.tasks.delete(task);
    });
  }
}

/**
 * Client-side interface to interact with a remote AgentSession.
 *
 * This class allows frontends/clients to:
 * - Subscribe to real-time events from the agent session
 * - Query session state, chat history, and agent info via RPC
 * - Send messages to the agent
 *
 * Example:
 * ```typescript
 * const session = new RemoteSession(room, agentIdentity);
 * session.on('agent_state_changed', (event) => {
 *   console.log('Agent state changed:', event.new_state);
 * });
 * session.on('user_state_changed', (event) => {
 *   console.log('User state changed:', event.new_state);
 * });
 * session.on('conversation_item_added', (event) => {
 *   console.log('Conversation item added:', event.item);
 * });
 * await session.start();
 *
 * const state = await session.fetchSessionState();
 * console.log('Session state:', state);
 *
 * const response = await session.sendMessage('Hello!');
 * console.log('Response:', response);
 * ```
 */
// TODO: expose this class
/** @experimental */
export class RemoteSession extends (EventEmitter as new () => TypedEventEmitter<RemoteSessionCallbacks>) {
  private readonly room: Room;
  private readonly agentIdentity: string;
  private started = false;

  private readonly tasks = new Set<Task<void>>();
  private readonly pendingRequests = new Map<string, Future<StreamResponse>>();
  private readonly logger = log();

  constructor(room: Room, agentIdentity: string) {
    super();
    this.room = room;
    this.agentIdentity = agentIdentity;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.room.registerTextStreamHandler(TOPIC_CLIENT_EVENTS, this.onEventStream);
    this.room.registerTextStreamHandler(TOPIC_AGENT_RESPONSE, this.onResponseStream);
  }

  async close(): Promise<void> {
    if (!this.started) return;

    this.started = false;
    this.room.unregisterTextStreamHandler(TOPIC_CLIENT_EVENTS);
    this.room.unregisterTextStreamHandler(TOPIC_AGENT_RESPONSE);

    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('RemoteSession closed'));
    }

    this.pendingRequests.clear();

    await cancelAndWait([...this.tasks]);
    this.tasks.clear();
  }

  private onEventStream = (
    reader: TextStreamReader,
    participantInfo: { identity: string },
  ): void => {
    if (participantInfo.identity !== this.agentIdentity) return;
    this.trackTask(Task.from(async () => this.readEvent(reader)));
  };

  private onResponseStream = (
    reader: TextStreamReader,
    participantInfo: { identity: string },
  ): void => {
    if (participantInfo.identity !== this.agentIdentity) return;
    this.trackTask(Task.from(async () => this.readResponse(reader)));
  };

  private async readResponse(reader: TextStreamReader): Promise<void> {
    try {
      const data = await reader.readAll();
      const response = streamResponseSchema.parse(JSON.parse(data));
      const future = this.pendingRequests.get(response.request_id);
      this.pendingRequests.delete(response.request_id);

      if (!future || future.done) return;
      future.resolve(response);
    } catch (e) {
      this.logger.warn({ error: e }, 'failed to read stream response');
    }
  }

  private async readEvent(reader: TextStreamReader): Promise<void> {
    try {
      const data = await reader.readAll();
      const event = this.parseEvent(data);
      if (event) {
        this.emit(event.type, event as never);
      }
    } catch (e) {
      this.logger.warn({ error: e }, 'failed to parse client event');
    }
  }

  private parseEvent(data: string): ClientEvent | null {
    try {
      const result = clientEventSchema.safeParse(JSON.parse(data));
      if (!result.success) {
        this.logger.warn({ error: result.error }, 'failed to validate event');
        return null;
      }
      return result.data;
    } catch (e) {
      this.logger.warn({ error: e }, 'failed to parse event');
      return null;
    }
  }

  private async sendRequest(method: string, payload: string, timeout = 60000): Promise<string> {
    const requestId = shortuuid('req_');
    const request: StreamRequest = {
      request_id: requestId,
      method,
      payload,
    };

    const future = new Future<StreamResponse>();
    this.pendingRequests.set(requestId, future);

    const localParticipant = this.room.localParticipant;
    if (!localParticipant) {
      this.pendingRequests.delete(requestId);
      throw new Error('RemoteSession room has no local participant');
    }

    await localParticipant.sendText(JSON.stringify(request), {
      topic: TOPIC_AGENT_REQUEST,
      destinationIdentities: [this.agentIdentity],
    });

    const timer = setTimeout(() => {
      if (!future.done) {
        this.pendingRequests.delete(requestId);
        future.reject(new Error(`RemoteSession request timed out: ${method}`));
      }
    }, timeout);

    try {
      const response = await future.await;
      if (response.error) {
        throw new Error(response.error);
      }
      return response.payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchSessionState(): Promise<GetSessionStateResponse> {
    const raw = JSON.parse(await this.sendRequest('get_session_state', '{}'));
    return getSessionStateResponseSchema.parse(raw);
  }

  async fetchChatHistory(): Promise<GetChatHistoryResponse> {
    const raw = JSON.parse(await this.sendRequest('get_chat_history', '{}'));
    return getChatHistoryResponseSchema.parse(raw);
  }

  async fetchAgentInfo(): Promise<GetAgentInfoResponse> {
    const raw = JSON.parse(await this.sendRequest('get_agent_info', '{}'));
    return getAgentInfoResponseSchema.parse(raw);
  }

  async sendMessage(text: string, responseTimeout = 60000): Promise<SendMessageResponse> {
    const payload = JSON.stringify({ text } satisfies SendMessageRequest);
    const raw = JSON.parse(await this.sendRequest('send_message', payload, responseTimeout));
    return sendMessageResponseSchema.parse(raw);
  }

  async fetchRtcStats(): Promise<GetRTCStatsResponse> {
    const raw = JSON.parse(await this.sendRequest('get_rtc_stats', '{}'));
    return getRTCStatsResponseSchema.parse(raw);
  }

  async fetchSessionUsage(): Promise<GetSessionUsageResponse> {
    const raw = JSON.parse(await this.sendRequest('get_session_usage', '{}'));
    return getSessionUsageResponseSchema.parse(raw);
  }

  private trackTask(task: Task<void>): void {
    this.tasks.add(task);
    task.addDoneCallback(() => {
      this.tasks.delete(task);
    });
  }
}
