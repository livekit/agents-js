// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Timestamp } from '@bufbuild/protobuf';
import { AgentSession as pb } from '@livekit/protocol';
import type { ByteStreamReader, Room, TextStreamInfo } from '@livekit/rtc-node';
import { ThrowsPromise } from '@livekit/throws-transformer/throws';
import type { TypedEventEmitter } from '@livekit/typed-emitter';
import EventEmitter from 'events';
import { TOPIC_SESSION_MESSAGES } from '../constants.js';
import type { OverlappingSpeechEvent } from '../inference/interruption/types.js';
import type {
  ChatItem,
  FunctionCall as FCItem,
  FunctionCallOutput as FCOItem,
} from '../llm/chat_context.js';
import type { ToolContext } from '../llm/tool_context.js';
import { log } from '../log.js';
import type {
  InterruptionModelUsage,
  LLMModelUsage,
  STTModelUsage,
  TTSModelUsage,
} from '../metrics/model_usage.js';
import { Future, Task, shortuuid } from '../utils.js';
import { version } from '../version.js';
import type { AgentSession, AgentSessionUsage } from './agent_session.js';
import {
  AgentSessionEventTypes,
  type AgentState,
  type AgentStateChangedEvent,
  type ConversationItemAddedEvent,
  type ErrorEvent,
  type FunctionToolsExecutedEvent,
  type MetricsCollectedEvent,
  type UserInputTranscribedEvent,
  type UserState,
  type UserStateChangedEvent,
} from './events.js';
import type { RoomIO } from './room_io/room_io.js';

// ===========================================================================
// Shared types (TextInput, Client event types, wire format aliases)
// ===========================================================================

export interface TextInputEvent {
  text: string;
  info?: TextStreamInfo;
  participantIdentity?: string;
}

export type TextInputCallback = (session: AgentSession, ev: TextInputEvent) => void | Promise<void>;

/** @experimental */
export type RemoteSessionEventTypes =
  | 'agent_state_changed'
  | 'user_state_changed'
  | 'conversation_item_added'
  | 'user_input_transcribed'
  | 'function_tools_executed'
  | 'overlapping_speech'
  | 'session_usage'
  | 'error';

/** @experimental */
export type RemoteSessionCallbacks = {
  agent_state_changed: (ev: pb.AgentSessionEvent_AgentStateChanged) => void;
  user_state_changed: (ev: pb.AgentSessionEvent_UserStateChanged) => void;
  conversation_item_added: (ev: pb.AgentSessionEvent_ConversationItemAdded) => void;
  user_input_transcribed: (ev: pb.AgentSessionEvent_UserInputTranscribed) => void;
  function_tools_executed: (ev: pb.AgentSessionEvent_FunctionToolsExecuted) => void;
  overlapping_speech: (ev: pb.AgentSessionEvent_OverlappingSpeech) => void;
  session_usage: (ev: pb.AgentSessionEvent_SessionUsageUpdated) => void;
  error: (ev: pb.AgentSessionEvent_Error) => void;
};

// ===========================================================================
// SessionTransport
// ===========================================================================

export abstract class SessionTransport {
  async start(): Promise<void> {}
  abstract sendMessage(msg: pb.AgentSessionMessage): Promise<void>;
  abstract close(): Promise<void>;
  abstract [Symbol.asyncIterator](): AsyncIterator<pb.AgentSessionMessage>;
}

export class RoomSessionTransport extends SessionTransport {
  private readonly room: Room;
  private handlerRegistered = false;
  private closed = false;
  private pendingMessages: pb.AgentSessionMessage[] = [];
  private waitingResolve: ((value: IteratorResult<pb.AgentSessionMessage>) => void) | null = null;
  private roomIO: RoomIO;

  constructor(room: Room, roomIO: RoomIO) {
    super();
    this.room = room;
    this.roomIO = roomIO;
  }

  private getRemoteIdentity() {
    return this.roomIO.linkedParticipant?.identity;
  }

  override async start(): Promise<void> {
    if (this.handlerRegistered) return;
    this.room.registerByteStreamHandler(TOPIC_SESSION_MESSAGES, this.onByteStream);
    this.handlerRegistered = true;
  }

  private onByteStream = (reader: ByteStreamReader, participantInfo: { identity: string }) => {
    if (this.getRemoteIdentity() && participantInfo.identity !== this.getRemoteIdentity()) {
      return;
    }
    this.readStream(reader).catch((e) => {
      log().warn({ error: e }, 'failed to read binary stream message');
    });
  };

  private async readStream(reader: ByteStreamReader): Promise<void> {
    try {
      const chunks = await reader.readAll();
      let totalLength = 0;
      for (const chunk of chunks) {
        totalLength += chunk.length;
      }
      const data = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      const msg = pb.AgentSessionMessage.fromBinary(data);
      this.enqueue(msg);
    } catch (e) {
      if (!this.closed) {
        log().warn({ error: e }, 'failed to parse binary stream message');
      }
    }
  }

  override async sendMessage(msg: pb.AgentSessionMessage): Promise<void> {
    if (this.closed || !this.room.isConnected) return;

    try {
      const data = msg.toBinary();
      const opts: Record<string, unknown> = {
        topic: TOPIC_SESSION_MESSAGES,
        name: shortuuid('AS_'),
      };
      const remoteIdentity = this.getRemoteIdentity();
      if (remoteIdentity) {
        opts.destinationIdentities = [remoteIdentity];
      }
      const writer = await this.room.localParticipant!.streamBytes(opts);
      await writer.write(new Uint8Array(data));
      await writer.close();
    } catch (e) {
      log().warn({ error: e }, 'failed to send binary stream message');
    }
  }

  override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.handlerRegistered) {
      try {
        this.room.unregisterByteStreamHandler(TOPIC_SESSION_MESSAGES);
      } catch (e) {
        log().debug({ error: e }, 'byte stream handler already unregistered');
      }
      this.handlerRegistered = false;
    }

    if (this.waitingResolve) {
      this.waitingResolve({
        value: undefined as unknown as pb.AgentSessionMessage,
        done: true,
      });
      this.waitingResolve = null;
    }
  }

  private enqueue(msg: pb.AgentSessionMessage): void {
    if (this.closed) return;

    if (this.waitingResolve) {
      const resolve = this.waitingResolve;
      this.waitingResolve = null;
      resolve({ value: msg, done: false });
    } else {
      this.pendingMessages.push(msg);
    }
  }

  override [Symbol.asyncIterator](): AsyncIterator<pb.AgentSessionMessage> {
    return {
      next: (): Promise<IteratorResult<pb.AgentSessionMessage>> => {
        if (this.closed && this.pendingMessages.length === 0) {
          return ThrowsPromise.resolve({
            value: undefined as unknown as pb.AgentSessionMessage,
            done: true,
          });
        }

        const pending = this.pendingMessages.shift();
        if (pending) {
          return ThrowsPromise.resolve({ value: pending, done: false });
        }

        return new ThrowsPromise<IteratorResult<pb.AgentSessionMessage>, never>((resolve) => {
          this.waitingResolve = resolve;
        });
      },
      return: (): Promise<IteratorResult<pb.AgentSessionMessage>> => {
        this.close();
        return ThrowsPromise.resolve({
          value: undefined as unknown as pb.AgentSessionMessage,
          done: true,
        });
      },
    };
  }
}

// ===========================================================================
// Enum maps
// ===========================================================================
const AGENT_STATE_MAP: Record<AgentState, pb.AgentState> = {
  initializing: pb.AgentState.AS_INITIALIZING,
  idle: pb.AgentState.AS_IDLE,
  listening: pb.AgentState.AS_LISTENING,
  thinking: pb.AgentState.AS_THINKING,
  speaking: pb.AgentState.AS_SPEAKING,
};

const USER_STATE_MAP: Record<UserState, pb.UserState> = {
  speaking: pb.UserState.US_SPEAKING,
  listening: pb.UserState.US_LISTENING,
  away: pb.UserState.US_AWAY,
};

// ===========================================================================
// Chat item / timestamp conversion helpers
// ===========================================================================
function msToTimestamp(ms: number): Timestamp {
  return Timestamp.fromDate(new Date(ms));
}

function nowTimestamp(): Timestamp {
  return Timestamp.fromDate(new Date());
}

function chatItemToProto(item: ChatItem): pb.ChatContext_ChatItem {
  switch (item.type) {
    case 'message': {
      const msg = item;
      const roleMap: Record<string, pb.ChatRole> = {
        developer: pb.ChatRole.DEVELOPER,
        system: pb.ChatRole.SYSTEM,
        user: pb.ChatRole.USER,
        assistant: pb.ChatRole.ASSISTANT,
      };
      const content: pb.ChatMessage_ChatContent[] = [];
      for (const c of msg.content) {
        if (typeof c === 'string') {
          content.push(new pb.ChatMessage_ChatContent({ payload: { case: 'text', value: c } }));
        }
      }

      const metricsReport = new pb.MetricsReport();
      if (msg.metrics.transcriptionDelay !== undefined)
        metricsReport.transcriptionDelay = msg.metrics.transcriptionDelay;
      if (msg.metrics.endOfTurnDelay !== undefined)
        metricsReport.endOfTurnDelay = msg.metrics.endOfTurnDelay;
      if (msg.metrics.onUserTurnCompletedDelay !== undefined)
        metricsReport.onUserTurnCompletedDelay = msg.metrics.onUserTurnCompletedDelay;
      if (msg.metrics.llmNodeTtft !== undefined)
        metricsReport.llmNodeTtft = msg.metrics.llmNodeTtft;
      if (msg.metrics.ttsNodeTtfb !== undefined)
        metricsReport.ttsNodeTtfb = msg.metrics.ttsNodeTtfb;
      if (msg.metrics.e2eLatency !== undefined) metricsReport.e2eLatency = msg.metrics.e2eLatency;

      const pbMsg = new pb.ChatMessage({
        id: msg.id,
        role: roleMap[msg.role] ?? pb.ChatRole.ASSISTANT,
        content,
        interrupted: msg.interrupted,
        metrics: metricsReport,
        createdAt: msToTimestamp(msg.createdAt),
      });
      if (msg.transcriptConfidence !== undefined) {
        pbMsg.transcriptConfidence = msg.transcriptConfidence;
      }
      return new pb.ChatContext_ChatItem({ item: { case: 'message', value: pbMsg } });
    }
    case 'function_call': {
      const fc = item;
      return new pb.ChatContext_ChatItem({
        item: {
          case: 'functionCall',
          value: new pb.FunctionCall({
            id: fc.id,
            callId: fc.callId,
            name: fc.name,
            arguments: fc.args,
            createdAt: msToTimestamp(fc.createdAt),
          }),
        },
      });
    }
    case 'function_call_output': {
      const fco = item;
      return new pb.ChatContext_ChatItem({
        item: {
          case: 'functionCallOutput',
          value: new pb.FunctionCallOutput({
            id: fco.id,
            callId: fco.callId,
            name: fco.name,
            output: fco.output,
            isError: fco.isError,
            createdAt: msToTimestamp(fco.createdAt),
          }),
        },
      });
    }
    case 'agent_handoff': {
      const ah = item;
      return new pb.ChatContext_ChatItem({
        item: {
          case: 'agentHandoff',
          value: new pb.AgentHandoff({
            id: ah.id,
            oldAgentId: ah.oldAgentId,
            newAgentId: ah.newAgentId,
            createdAt: msToTimestamp(ah.createdAt),
          }),
        },
      });
    }
  }
}

// ===========================================================================
// Usage conversion helpers
// ===========================================================================
function sessionUsageToProto(usage: AgentSessionUsage): pb.AgentSessionUsage {
  const modelUsages: pb.ModelUsage[] = [];
  for (const mu of usage.modelUsage) {
    switch (mu.type) {
      case 'llm_usage': {
        const lu = mu as Partial<LLMModelUsage>;
        modelUsages.push(
          new pb.ModelUsage({
            usage: {
              case: 'llm',
              value: new pb.LLMModelUsage({
                provider: lu.provider ?? '',
                model: lu.model ?? '',
                inputTokens: lu.inputTokens ?? 0,
                inputCachedTokens: lu.inputCachedTokens ?? 0,
                inputAudioTokens: lu.inputAudioTokens ?? 0,
                inputCachedAudioTokens: lu.inputCachedAudioTokens ?? 0,
                inputTextTokens: lu.inputTextTokens ?? 0,
                inputCachedTextTokens: lu.inputCachedTextTokens ?? 0,
                inputImageTokens: lu.inputImageTokens ?? 0,
                inputCachedImageTokens: lu.inputCachedImageTokens ?? 0,
                outputTokens: lu.outputTokens ?? 0,
                outputAudioTokens: lu.outputAudioTokens ?? 0,
                outputTextTokens: lu.outputTextTokens ?? 0,
                sessionDuration: (lu.sessionDurationMs ?? 0) / 1000,
              }),
            },
          }),
        );
        break;
      }
      case 'tts_usage': {
        const tu = mu as Partial<TTSModelUsage>;
        modelUsages.push(
          new pb.ModelUsage({
            usage: {
              case: 'tts',
              value: new pb.TTSModelUsage({
                provider: tu.provider ?? '',
                model: tu.model ?? '',
                inputTokens: tu.inputTokens ?? 0,
                outputTokens: tu.outputTokens ?? 0,
                charactersCount: tu.charactersCount ?? 0,
                audioDuration: (tu.audioDurationMs ?? 0) / 1000,
              }),
            },
          }),
        );
        break;
      }
      case 'stt_usage': {
        const su = mu as Partial<STTModelUsage>;
        modelUsages.push(
          new pb.ModelUsage({
            usage: {
              case: 'stt',
              value: new pb.STTModelUsage({
                provider: su.provider ?? '',
                model: su.model ?? '',
                inputTokens: su.inputTokens ?? 0,
                outputTokens: su.outputTokens ?? 0,
                audioDuration: (su.audioDurationMs ?? 0) / 1000,
              }),
            },
          }),
        );
        break;
      }
      case 'interruption_usage': {
        const iu = mu as Partial<InterruptionModelUsage>;
        modelUsages.push(
          new pb.ModelUsage({
            usage: {
              case: 'interruption',
              value: new pb.InterruptionModelUsage({
                provider: iu.provider ?? '',
                model: iu.model ?? '',
                totalRequests: iu.totalRequests ?? 0,
              }),
            },
          }),
        );
        break;
      }
    }
  }
  return new pb.AgentSessionUsage({ modelUsage: modelUsages });
}

function toolNames(toolCtx: ToolContext | undefined): string[] {
  if (!toolCtx) return [];
  return Object.keys(toolCtx);
}

function protoSerializeOptions(opts: {
  turnHandling?: { endpointing?: unknown; interruption?: unknown };
  maxToolSteps?: number;
  userAwayTimeout?: number | null;
  preemptiveGeneration?: boolean;
  useTtsAlignedTranscript?: boolean;
}): Record<string, string> {
  return {
    endpointing: JSON.stringify(opts.turnHandling?.endpointing ?? {}),
    interruption: JSON.stringify(opts.turnHandling?.interruption ?? {}),
    max_tool_steps: String(opts.maxToolSteps ?? 0),
    user_away_timeout: String(opts.userAwayTimeout ?? ''),
    preemptive_generation: String(opts.preemptiveGeneration ?? false),
    use_tts_aligned_transcript: String(opts.useTtsAlignedTranscript ?? false),
  };
}

// ===========================================================================
// SessionHost (protobuf-based server-side handler)
// ===========================================================================
export class SessionHost {
  private readonly transport: SessionTransport;
  private session: AgentSession | undefined;
  private started = false;
  private eventsRegistered = false;
  private recvTask: Task<void> | undefined;
  private readonly tasks = new Set<Task<void>>();
  private textInputCb: TextInputCallback | undefined;

  constructor(transport: SessionTransport) {
    this.transport = transport;
  }

  registerSession(session: AgentSession): void {
    this.session = session;
    if (!this.eventsRegistered) {
      this.eventsRegistered = true;
      session.on(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);
      session.on(AgentSessionEventTypes.UserStateChanged, this.onUserStateChanged);
      session.on(AgentSessionEventTypes.ConversationItemAdded, this.onConversationItemAdded);
      session.on(AgentSessionEventTypes.UserInputTranscribed, this.onUserInputTranscribed);
      session.on(AgentSessionEventTypes.FunctionToolsExecuted, this.onFunctionToolsExecuted);
      session.on(AgentSessionEventTypes.MetricsCollected, this.onMetricsCollected);
      session.on(AgentSessionEventTypes.OverlappingSpeech, this.onOverlappingSpeech);
      session.on(AgentSessionEventTypes.Error, this.onHostError);
    }
  }

  registerTextInput(textInputCb: TextInputCallback): void {
    this.textInputCb = textInputCb;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.transport.start();
    this.recvTask = Task.from(async () => this.recvLoop());
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.session && this.eventsRegistered) {
      this.eventsRegistered = false;
      this.session.off(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);
      this.session.off(AgentSessionEventTypes.UserStateChanged, this.onUserStateChanged);
      this.session.off(AgentSessionEventTypes.ConversationItemAdded, this.onConversationItemAdded);
      this.session.off(AgentSessionEventTypes.UserInputTranscribed, this.onUserInputTranscribed);
      this.session.off(AgentSessionEventTypes.FunctionToolsExecuted, this.onFunctionToolsExecuted);
      this.session.off(AgentSessionEventTypes.MetricsCollected, this.onMetricsCollected);
      this.session.off(AgentSessionEventTypes.OverlappingSpeech, this.onOverlappingSpeech);
      this.session.off(AgentSessionEventTypes.Error, this.onHostError);
    }

    if (this.recvTask) {
      this.recvTask.cancel();
    }

    await ThrowsPromise.allSettled([...this.tasks].map((task) => task.cancelAndWait()));
    this.tasks.clear();

    await this.transport.close();
  }

  private async recvLoop(): Promise<void> {
    try {
      for await (const msg of this.transport) {
        if (msg.message.case === 'request') {
          if (this.session) {
            this.trackTask(
              Task.from(async () => this.handleRequestSafe(msg.message.value as pb.SessionRequest)),
            );
          }
        }
      }
    } catch (e) {
      if (this.started) {
        log().warn({ error: e }, 'error processing session message');
      }
    }
  }

  private sendEvent(event: pb.AgentSessionEvent): void {
    const msg = new pb.AgentSessionMessage({
      message: { case: 'event', value: event },
    });
    this.trackTask(Task.from(async () => this.transport.sendMessage(msg)));
  }

  private emitEvent<Event extends pb.AgentSessionEvent['event']>(
    event: Event,
    createdAt?: number,
  ): void {
    this.sendEvent(
      new pb.AgentSessionEvent({
        createdAt: createdAt ? msToTimestamp(createdAt) : nowTimestamp(),
        event: event,
      }),
    );
  }

  private onAgentStateChanged = (event: AgentStateChangedEvent): void => {
    this.emitEvent(
      {
        case: 'agentStateChanged',
        value: new pb.AgentSessionEvent_AgentStateChanged({
          oldState: AGENT_STATE_MAP[event.oldState],
          newState: AGENT_STATE_MAP[event.newState],
        }),
      },
      event.createdAt,
    );
  };

  private onUserStateChanged = (event: UserStateChangedEvent): void => {
    this.emitEvent(
      {
        case: 'userStateChanged',
        value: new pb.AgentSessionEvent_UserStateChanged({
          oldState: USER_STATE_MAP[event.oldState],
          newState: USER_STATE_MAP[event.newState],
        }),
      },
      event.createdAt,
    );
  };

  private onUserInputTranscribed = (event: UserInputTranscribedEvent): void => {
    this.emitEvent(
      {
        case: 'userInputTranscribed',
        value: new pb.AgentSessionEvent_UserInputTranscribed({
          transcript: event.transcript,
          isFinal: event.isFinal,
        }),
      },
      event.createdAt,
    );
  };

  private onConversationItemAdded = (event: ConversationItemAddedEvent): void => {
    this.emitEvent(
      {
        case: 'conversationItemAdded',
        value: new pb.AgentSessionEvent_ConversationItemAdded({
          item: chatItemToProto(event.item),
        }),
      },
      event.createdAt,
    );
  };

  private onFunctionToolsExecuted = (event: FunctionToolsExecutedEvent): void => {
    const pbCalls = event.functionCalls.map(
      (fc: FCItem) => new pb.FunctionCall({ name: fc.name, arguments: fc.args, callId: fc.callId }),
    );
    const pbOutputs = event.functionCallOutputs
      .filter((fco): fco is FCOItem => fco != null)
      .map(
        (fco: FCOItem) =>
          new pb.FunctionCallOutput({
            callId: fco.callId,
            output: fco.output,
            isError: fco.isError,
          }),
      );
    this.emitEvent(
      {
        case: 'functionToolsExecuted',
        value: new pb.AgentSessionEvent_FunctionToolsExecuted({
          functionCalls: pbCalls,
          functionCallOutputs: pbOutputs,
        }),
      },
      event.createdAt,
    );
  };

  private onOverlappingSpeech = (event: OverlappingSpeechEvent): void => {
    const value = new pb.AgentSessionEvent_OverlappingSpeech({
      isInterruption: event.isInterruption,
      detectionDelay: event.detectionDelayInS,
      detectedAt: msToTimestamp(event.detectedAt),
    });
    if (event.overlapStartedAt != null) {
      value.overlapStartedAt = msToTimestamp(event.overlapStartedAt);
    }
    this.emitEvent({ case: 'overlappingSpeech', value });
  };

  private onMetricsCollected = (event: MetricsCollectedEvent): void => {
    if (!this.session) return;
    this.emitEvent(
      {
        case: 'sessionUsageUpdated',
        value: new pb.AgentSessionEvent_SessionUsageUpdated({
          usage: sessionUsageToProto(this.session.usage),
        }),
      },
      event.createdAt,
    );
  };

  private onHostError = (event: ErrorEvent): void => {
    this.emitEvent(
      {
        case: 'error',
        value: new pb.AgentSessionEvent_Error({
          message: event.error ? String(event.error) : 'Unknown error',
        }),
      },
      event.createdAt,
    );
  };

  private async handleRequestSafe(req: pb.SessionRequest): Promise<void> {
    try {
      await this.handleRequest(req);
    } catch (e) {
      log().warn({ error: e, requestId: req.requestId }, 'error handling session request');
      try {
        const resp = new pb.AgentSessionMessage({
          message: {
            case: 'response',
            value: new pb.SessionResponse({
              requestId: req.requestId,
              error: 'internal error',
            }),
          },
        });
        await this.transport.sendMessage(resp);
      } catch (e) {
        log().debug({ error: e }, 'failed to send error response');
      }
    }
  }

  private async handleRequest(req: pb.SessionRequest): Promise<void> {
    if (!this.session) return;

    switch (req.request.case) {
      case 'ping':
        return this.sendResponse(req.requestId, {
          case: 'pong',
          value: new pb.SessionResponse_Pong(),
        });
      case 'getChatHistory':
        return this.handleGetChatHistory(req.requestId);
      case 'getAgentInfo':
        return this.handleGetAgentInfo(req.requestId);
      case 'runInput':
        return this.handleRunInput(req.requestId, req.request.value);
      case 'getSessionState':
        return this.handleGetSessionState(req.requestId);
      case 'getRtcStats':
        return this.sendResponse(req.requestId, {
          case: 'getRtcStats',
          value: new pb.SessionResponse_GetRTCStatsResponse({
            publisherStats: [],
            subscriberStats: [],
          }),
        });
      case 'getSessionUsage':
        return this.handleGetSessionUsage(req.requestId);
      case 'getFrameworkInfo':
        return this.sendResponse(req.requestId, {
          case: 'getFrameworkInfo',
          value: new pb.SessionResponse_GetFrameworkInfoResponse({
            sdk: 'js',
            sdkVersion: version,
          }),
        });
    }
  }

  private async handleGetChatHistory(requestId: string): Promise<void> {
    const items = this.session!.history.items.map(chatItemToProto);
    return this.sendResponse(requestId, {
      case: 'getChatHistory',
      value: new pb.SessionResponse_GetChatHistoryResponse({ items }),
    });
  }

  private async handleGetAgentInfo(requestId: string): Promise<void> {
    const agent = this.session!.currentAgent;
    return this.sendResponse(requestId, {
      case: 'getAgentInfo',
      value: new pb.SessionResponse_GetAgentInfoResponse({
        id: agent.id,
        instructions: agent.instructions,
        tools: toolNames(agent.toolCtx),
        chatCtx: agent.chatCtx.items.map(chatItemToProto),
      }),
    });
  }

  private async handleRunInput(
    requestId: string,
    input: pb.SessionRequest_RunInput,
  ): Promise<void> {
    const text = input.text;
    let items: pb.ChatContext_ChatItem[] = [];
    let error: string | undefined;

    if (text) {
      if (this.textInputCb) {
        const cbResult = this.textInputCb(this.session!, { text });
        if (cbResult instanceof Promise) {
          await cbResult;
        }
      } else {
        try {
          await this.session!.interrupt({ force: true }).await;
        } catch {
          // ignore
        }

        const result = this.session!.run({ userInput: text });
        try {
          await result.wait();
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        items = result.events.map((ev) => chatItemToProto(ev.item));
      }
    }

    return this.sendResponse(
      requestId,
      {
        case: 'runInput',
        value: new pb.SessionResponse_RunInputResponse({ items }),
      },
      error,
    );
  }

  private async handleGetSessionState(requestId: string): Promise<void> {
    const agent = this.session!.currentAgent;
    const startedAt = this.session!._startedAt ?? Date.now();
    return this.sendResponse(requestId, {
      case: 'getSessionState',
      value: new pb.SessionResponse_GetSessionStateResponse({
        agentState: AGENT_STATE_MAP[this.session!.agentState],
        userState: USER_STATE_MAP[this.session!.userState],
        agentId: agent.id,
        options: protoSerializeOptions({
          turnHandling: this.session!.sessionOptions.turnHandling,
          maxToolSteps: this.session!.sessionOptions.maxToolSteps,
          userAwayTimeout: this.session!.sessionOptions.userAwayTimeout,
          preemptiveGeneration: this.session!.sessionOptions.preemptiveGeneration,
          useTtsAlignedTranscript: this.session!.sessionOptions.useTtsAlignedTranscript,
        }),
        createdAt: msToTimestamp(startedAt),
      }),
    });
  }

  private async handleGetSessionUsage(requestId: string): Promise<void> {
    return this.sendResponse(requestId, {
      case: 'getSessionUsage',
      value: new pb.SessionResponse_GetSessionUsageResponse({
        usage: sessionUsageToProto(this.session!.usage),
        createdAt: nowTimestamp(),
      }),
    });
  }

  private async sendResponse(
    requestId: string,
    response: pb.SessionResponse['response'],
    error?: string,
  ): Promise<void> {
    await this.transport.sendMessage(
      new pb.AgentSessionMessage({
        message: {
          case: 'response',
          value: new pb.SessionResponse({ requestId, response, error }),
        },
      }),
    );
  }

  private trackTask(task: Task<void>): void {
    this.tasks.add(task);
    task.addDoneCallback(() => {
      this.tasks.delete(task);
    });
  }
}

// ===========================================================================
// RemoteSession (protobuf-based client-side interface)
// ===========================================================================

/** @experimental */
export class RemoteSession extends (EventEmitter as new () => TypedEventEmitter<RemoteSessionCallbacks>) {
  private readonly transport: SessionTransport;
  private started = false;

  private readonly tasks = new Set<Task<void>>();
  private readonly pendingRequests = new Map<string, Future<pb.SessionResponse>>();
  private recvTask: Task<void> | undefined;
  private readonly _logger = log();

  constructor(transport: SessionTransport) {
    super();
    this.transport = transport;
  }

  static fromRoom(room: Room, roomIO: RoomIO): RemoteSession {
    const transport = new RoomSessionTransport(room, roomIO);
    return new RemoteSession(transport);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.transport.start();
    this.recvTask = Task.from(async () => this.recvLoop());
  }

  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.recvTask) {
      this.recvTask.cancel();
    }

    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('RemoteSession closed'));
    }
    this.pendingRequests.clear();

    for (const task of this.tasks) {
      task.cancel();
    }
    this.tasks.clear();

    await this.transport.close();
  }

  private async recvLoop(): Promise<void> {
    try {
      for await (const msg of this.transport) {
        switch (msg.message.case) {
          case 'event':
            this.dispatchEvent(msg.message.value);
            break;
          case 'response':
            this.dispatchResponse(msg.message.value);
            break;
        }
      }
    } catch (e) {
      if (this.started) {
        this._logger.warn({ error: e }, 'error in RemoteSession recv loop');
      }
    }
  }

  private dispatchEvent(event: pb.AgentSessionEvent): void {
    const ev = event.event;
    switch (ev.case) {
      case 'agentStateChanged':
        this.emit('agent_state_changed', ev.value);
        break;
      case 'userStateChanged':
        this.emit('user_state_changed', ev.value);
        break;
      case 'userInputTranscribed':
        this.emit('user_input_transcribed', ev.value);
        break;
      case 'conversationItemAdded':
        this.emit('conversation_item_added', ev.value);
        break;
      case 'functionToolsExecuted':
        this.emit('function_tools_executed', ev.value);
        break;
      case 'overlappingSpeech':
        this.emit('overlapping_speech', ev.value);
        break;
      case 'sessionUsageUpdated':
        this.emit('session_usage', ev.value);
        break;
      case 'error':
        this.emit('error', ev.value);
        break;
    }
  }

  private dispatchResponse(response: pb.SessionResponse): void {
    const future = this.pendingRequests.get(response.requestId);
    this.pendingRequests.delete(response.requestId);
    if (future && !future.done) {
      future.resolve(response);
    }
  }

  private async sendRequest(
    buildReq: (requestId: string) => pb.SessionRequest,
    timeout = 60000,
  ): Promise<pb.SessionResponse> {
    const requestId = shortuuid('req_');
    const req = buildReq(requestId);
    req.requestId = requestId;

    const future = new Future<pb.SessionResponse>();
    this.pendingRequests.set(requestId, future);

    const msg = new pb.AgentSessionMessage({
      message: { case: 'request', value: req },
    });
    await this.transport.sendMessage(msg);

    const timer = setTimeout(() => {
      if (!future.done) {
        this.pendingRequests.delete(requestId);
        future.reject(new Error('RemoteSession request timed out'));
      }
    }, timeout);

    try {
      const response = await future.await;
      if (response.error) {
        throw new Error(response.error);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchSessionState(): Promise<pb.SessionResponse_GetSessionStateResponse> {
    const resp = await this.sendRequest(
      (id) =>
        new pb.SessionRequest({
          requestId: id,
          request: { case: 'getSessionState', value: new pb.SessionRequest_GetSessionState() },
        }),
    );
    if (resp.response.case !== 'getSessionState') {
      throw new Error('unexpected response type');
    }
    return resp.response.value;
  }

  async fetchChatHistory(): Promise<pb.SessionResponse_GetChatHistoryResponse> {
    const resp = await this.sendRequest(
      (id) =>
        new pb.SessionRequest({
          requestId: id,
          request: { case: 'getChatHistory', value: new pb.SessionRequest_GetChatHistory() },
        }),
    );
    if (resp.response.case !== 'getChatHistory') {
      throw new Error('unexpected response type');
    }
    return resp.response.value;
  }

  async fetchAgentInfo(): Promise<pb.SessionResponse_GetAgentInfoResponse> {
    const resp = await this.sendRequest(
      (id) =>
        new pb.SessionRequest({
          requestId: id,
          request: { case: 'getAgentInfo', value: new pb.SessionRequest_GetAgentInfo() },
        }),
    );
    if (resp.response.case !== 'getAgentInfo') {
      throw new Error('unexpected response type');
    }
    return resp.response.value;
  }

  async sendMessage(
    text: string,
    responseTimeout = 60000,
  ): Promise<pb.SessionResponse_RunInputResponse> {
    const resp = await this.sendRequest(
      (id) =>
        new pb.SessionRequest({
          requestId: id,
          request: { case: 'runInput', value: new pb.SessionRequest_RunInput({ text }) },
        }),
      responseTimeout,
    );
    if (resp.response.case !== 'runInput') {
      throw new Error('unexpected response type');
    }
    return resp.response.value;
  }

  async fetchRtcStats(): Promise<pb.SessionResponse_GetRTCStatsResponse> {
    const resp = await this.sendRequest(
      (id) =>
        new pb.SessionRequest({
          requestId: id,
          request: { case: 'getRtcStats', value: new pb.SessionRequest_GetRTCStats() },
        }),
    );
    if (resp.response.case !== 'getRtcStats') {
      throw new Error('unexpected response type');
    }
    return resp.response.value;
  }

  async fetchSessionUsage(): Promise<pb.SessionResponse_GetSessionUsageResponse> {
    const resp = await this.sendRequest(
      (id) =>
        new pb.SessionRequest({
          requestId: id,
          request: { case: 'getSessionUsage', value: new pb.SessionRequest_GetSessionUsage() },
        }),
    );
    if (resp.response.case !== 'getSessionUsage') {
      throw new Error('unexpected response type');
    }
    return resp.response.value;
  }

  private trackTask(task: Task<void>): void {
    this.tasks.add(task);
    task.addDoneCallback(() => {
      this.tasks.delete(task);
    });
  }
}
