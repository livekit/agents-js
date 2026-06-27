// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { SIPOutboundConfig } from '@livekit/protocol';
import { type DisconnectReason, type ParticipantKind, Room, RoomEvent } from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient, SipClient, type VideoGrant } from 'livekit-server-sdk';
import { z } from 'zod';
import type { LLMModels, STTModelString, TTSModelString } from '../inference/index.js';
import { type JobContext, getJobContext } from '../job.js';
import type {
  ChatContext,
  Instructions,
  LLM,
  RealtimeModel,
  ToolContextEntry,
} from '../llm/index.js';
import { ToolError, ToolFlag, tool } from '../llm/index.js';
import { log } from '../log.js';
import type { STT } from '../stt/index.js';
import type { TTS } from '../tts/index.js';
import { Future, waitUntilAborted } from '../utils.js';
import type { VAD } from '../vad.js';
import { Agent, AgentTask } from '../voice/agent.js';
import { AgentSession, type TurnDetectionMode } from '../voice/agent_session.js';
import {
  type AudioConfig,
  type AudioSourceType,
  BackgroundAudioPlayer,
  BuiltinAudioClip,
  type PlayHandle,
} from '../voice/background_audio.js';
import { DEFAULT_PARTICIPANT_KINDS } from '../voice/room_io/index.js';
import type { InstructionParts } from './utils.js';

export interface WarmTransferResult {
  managerIdentity: string;
}

export interface WarmTransferTaskOptions {
  /** The phone number or SIP URI to dial for the manager. */
  sipCallTo?: string;
  /**
   * ID of a pre-configured LiveKit SIP outbound trunk used to originate the call.
   * Falls back to the `LIVEKIT_SIP_OUTBOUND_TRUNK` environment variable when not provided.
   */
  sipTrunkId?: string | null;
  /** Low-level SIP connection config for originating calls through a custom SIP domain. */
  sipConnection?: SIPOutboundConfig;
  /** Optional SIP From number. Falls back to `LIVEKIT_SIP_NUMBER`. */
  sipNumber?: string;
  /** Headers to include on the outbound SIP call. */
  sipHeaders?: Record<string, string>;
  /**
   * DTMF tones to send once the manager's call is answered, e.g. to dial an extension or
   * navigate an IVR menu (`'1234#'`). Insert `w` characters to pause ~0.5s each before/between
   * digits (`'wwww1234#'` waits ~2s, useful when the destination plays a greeting before
   * accepting input).
   */
  dtmf?: string | null;
  /**
   * How long to wait, in milliseconds, for the manager to answer before giving up. The
   * underlying SIP API only supports whole-second granularity, so the value is rounded to the
   * nearest second.
   */
  ringingTimeout?: number | null;
  /** Audio played to the caller while they are on hold during the transfer. */
  holdAudio?: AudioSourceType | AudioConfig | AudioConfig[] | null;
  /**
   * Instructions for the manager briefing. Pass a full string to replace the built-in prompt
   * entirely, or {@link InstructionParts} to override individual sections (e.g. `persona`) while
   * keeping the built-in template and auto-formatted conversation history.
   */
  instructions?: InstructionParts | string;
  chatCtx?: ChatContext;
  turnDetection?: TurnDetectionMode | null;
  tools?: readonly ToolContextEntry[];
  stt?: STT | STTModelString | null;
  vad?: VAD | null;
  llm?: LLM | RealtimeModel | LLMModels | null;
  tts?: TTS | TTSModelString | null;
  allowInterruptions?: boolean;
}

type IoState = {
  audioInput: boolean;
  audioOutput: boolean;
  transcriptionOutput: boolean;
};

/**
 * Build a warm-transfer {@link AgentTask} that dials a manager over SIP, briefs them
 * in a private consultation room, and (on confirmation) merges them into the caller room.
 *
 * This is the functional core; {@link WarmTransferTask} is a thin class wrapper over it.
 */
export function createWarmTransferTask({
  sipCallTo,
  sipTrunkId: rawSipTrunkId,
  sipConnection,
  sipNumber = process.env.LIVEKIT_SIP_NUMBER ?? '',
  sipHeaders = {},
  dtmf,
  ringingTimeout,
  holdAudio = { source: BuiltinAudioClip.HOLD_MUSIC, volume: 0.8 },
  instructions,
  chatCtx,
  turnDetection,
  tools,
  stt,
  vad,
  llm,
  tts,
  allowInterruptions,
}: WarmTransferTaskOptions = {}): AgentTask<WarmTransferResult> {
  if (!sipCallTo) {
    throw new Error('`sipCallTo` must be set');
  }

  // Resolve the SIP trunk: an explicit id wins, then a custom connection (which
  // skips the env fallback so it isn't silently overridden), then the env var.
  const sipTrunkId =
    rawSipTrunkId !== undefined
      ? rawSipTrunkId
      : sipConnection
        ? null
        : process.env.LIVEKIT_SIP_OUTBOUND_TRUNK ?? null;

  if (sipTrunkId === null && !sipConnection) {
    throw new Error(
      '`LIVEKIT_SIP_OUTBOUND_TRUNK` environment variable, `sipTrunkId`, or `sipConnection` must be set',
    );
  }

  const managerIdentity = 'manager-sip';
  const backgroundAudio = new BackgroundAudioPlayer();
  const logger = log();

  // Mutable state shared between the onEnter hook and the tools below. A closure
  // keeps it private to this task instance without the field-initializer ordering
  // pitfalls of a class.
  let callerRoom: Room | null = null;
  let consultationRoom: Room | null = null;
  // Captured eagerly in onEnter while the live job context is available. The
  // post-merge caller-room cleanup listener fires from a native rtc-node FFI
  // callback whose AsyncLocalStorage context is pinned to FfiClient-singleton
  // creation, so getJobContext() would read an empty/stale store there.
  let jobCtx: JobContext | null = null;
  let transferAgentSession: AgentSession | null = null;
  let holdAudioHandle: PlayHandle | null = null;
  let originalIoState: IoState | null = null;

  // Resolves when the consultation room/session fails, so onEnter stops waiting.
  const consultationFailedFut = new Future<void>();

  // `task` is created at the end of this function. The helpers and tools below
  // only read it at runtime (inside their bodies), long after it's assigned, so
  // the forward reference is safe.
  const setIoEnabled = (enabled: boolean): void => {
    const input = task.session.input;
    const output = task.session.output;

    originalIoState ??= {
      audioInput: input.audioEnabled,
      audioOutput: output.audioEnabled,
      transcriptionOutput: output.transcriptionEnabled,
    };

    if (input.audio) input.setAudioEnabled(enabled && originalIoState.audioInput);
    if (output.audio) output.setAudioEnabled(enabled && originalIoState.audioOutput);
    if (output.transcription)
      output.setTranscriptionEnabled(enabled && originalIoState.transcriptionOutput);
  };

  const setResult = (result: WarmTransferResult | Error): void => {
    if (task.done) return;

    if (transferAgentSession) {
      // shutdown() triggers deleteRoomOnClose, which disconnects the consultation
      // room and frees its WebSocket. The manager is already moved out
      // (mergeCalls) or torn down (failure) by now.
      transferAgentSession.shutdown();
      transferAgentSession = null;
      consultationRoom = null;
    }

    if (holdAudioHandle) {
      holdAudioHandle.stop();
      holdAudioHandle = null;
    }
    void backgroundAudio.close().catch((error) => {
      logger.warn({ error }, 'failed to close background audio');
    });

    setIoEnabled(true);
    task.complete(result);
  };

  const onConsultationRoomClose = (reason: DisconnectReason): void => {
    logger.debug({ reason }, 'consultation room closed');
    consultationFailedFut.resolve();
    setResult(new ToolError(`room closed: ${reason}`));
  };

  const onCallerParticipantDisconnected = (participant: {
    identity: string;
    kind: ParticipantKind;
  }): void => {
    if (!DEFAULT_PARTICIPANT_KINDS.includes(participant.kind)) {
      return;
    }

    logger.info(
      { participantIdentity: participant.identity },
      'participant disconnected from caller room, closing',
    );

    if (!callerRoom?.name) {
      return;
    }

    callerRoom.off(RoomEvent.ParticipantDisconnected, onCallerParticipantDisconnected);

    // Use the eagerly-captured job context: this callback runs from a native
    // rtc-node FFI event, where getJobContext() reads an empty/stale
    // AsyncLocalStorage store and would throw as an unhandled rejection.
    if (!jobCtx) {
      logger.warn('no job context captured, cannot delete caller room');
      return;
    }
    const callerRoomName = callerRoom.name;
    void jobCtx.deleteRoom(callerRoomName).catch((error) => {
      logger.warn({ error }, 'failed to delete caller room');
    });
  };

  const cleanupManagerDial = async (
    session?: AgentSession | null,
    room?: Room | null,
  ): Promise<void> => {
    await room?.disconnect().catch((error) => {
      logger.warn({ error }, 'failed to disconnect consultation room');
    });
    await session?.close().catch((error) => {
      logger.warn({ error }, 'failed to close transfer agent session');
    });
  };

  const mergeCalls = async (): Promise<void> => {
    if (!callerRoom?.name || !consultationRoom?.name) {
      throw new Error('calls are not ready to merge');
    }

    consultationRoom.off(RoomEvent.Disconnected, onConsultationRoomClose);

    logger.debug({ managerIdentity, callerRoom: callerRoom.name }, 'moving manager to caller room');

    const info = (jobCtx ?? getJobContext()).info;
    const rooms = new RoomServiceClient(info.url, info.apiKey, info.apiSecret);
    await rooms.moveParticipant(consultationRoom.name, managerIdentity, callerRoom.name);
  };

  /**
   * Dials the manager into a fresh consultation room and starts a copy of this
   * task there. Every awaited step is raced against `signal`; on abort the
   * `finally` block tears the half-built room/session down (the room/SIP SDK
   * calls themselves aren't AbortSignal-aware).
   */
  const dialManager = async (signal: AbortSignal): Promise<AgentSession> => {
    if (!callerRoom?.name) {
      throw new Error('caller room is not available');
    }
    const localIdentity = callerRoom.localParticipant?.identity;
    if (!localIdentity) {
      throw new Error('caller room local participant is not available');
    }

    const ctx = jobCtx ?? getJobContext();
    const consultationRoomName = `${callerRoom.name}-consultation-room`;
    const room = new Room();
    const transferAgent = new Agent({
      instructions: task.instructions,
      stt: task.stt,
      vad: task.vad,
      llm: task.llm,
      tts: task.tts,
      tools: task.toolCtx.tools,
      chatCtx: task.chatCtx.copy(),
      turnDetection: turnDetection ?? undefined,
      allowInterruptions,
    });

    let session: AgentSession | undefined;
    let completed = false;

    try {
      const token = new AccessToken(undefined, undefined, { identity: localIdentity });
      token.kind = 'agent';
      token.addGrant({
        roomJoin: true,
        room: consultationRoomName,
        canUpdateOwnMetadata: true,
        canPublish: true,
        canSubscribe: true,
      } as VideoGrant);

      logger.debug(
        { wsUrl: ctx.info.url, consultationRoomName },
        'connecting to consultation room',
      );
      const jwt = await token.toJwt();

      room.on(RoomEvent.Disconnected, onConsultationRoomClose);

      const connected = await waitUntilAborted(room.connect(ctx.info.url, jwt), signal);
      if (connected.isAborted) {
        throw new Error('dial cancelled');
      }

      // The consultation session reuses the caller session's models.
      session = new AgentSession({
        vad: task.session.vad,
        llm: task.session.llm,
        stt: task.session.stt,
        tts: task.session.tts,
        turnDetection: task.session.turnDetection,
      });

      const started = await waitUntilAborted(
        session.start({
          agent: transferAgent,
          room,
          inputOptions: {
            closeOnDisconnect: true,
            // Delete the consultation room on shutdown so its WebSocket doesn't
            // leak across transfers.
            deleteRoomOnClose: true,
            participantIdentity: managerIdentity,
          },
          record: false,
        }),
        signal,
      );
      if (started.isAborted) {
        throw new Error('dial cancelled');
      }

      const sip = new SipClient(ctx.info.url);
      const dialed = await waitUntilAborted(
        sip.createSipParticipant(
          sipTrunkId ?? '',
          sipCallTo,
          consultationRoomName,
          {
            participantIdentity: managerIdentity,
            waitUntilAnswered: true,
            fromNumber: sipNumber || undefined,
            headers: sipHeaders,
            dtmf: dtmf ?? undefined,
            // SIP API takes whole seconds (BigInt coercion throws on fractional input).
            ringingTimeout: ringingTimeout != null ? Math.round(ringingTimeout / 1000) : undefined,
          },
          sipConnection,
        ),
        signal,
      );
      if (dialed.isAborted) {
        throw new Error('dial cancelled');
      }

      consultationRoom = room;
      completed = true;
      return session;
    } finally {
      if (!completed) {
        room.off(RoomEvent.Disconnected, onConsultationRoomClose);
        await cleanupManagerDial(session, room);
      }
    }
  };

  const transferTools: ToolContextEntry[] = [
    tool({
      name: 'connect_to_caller',
      description: 'Called when the manager wants to connect to the caller.',
      flags: ToolFlag.IGNORE_ON_ENTER,
      execute: async () => {
        logger.debug('connecting to caller');
        if (!callerRoom) {
          throw new Error('caller room is not available');
        }

        await mergeCalls();
        setResult({ managerIdentity });
        callerRoom.on(RoomEvent.ParticipantDisconnected, onCallerParticipantDisconnected);
      },
    }),
    tool({
      name: 'decline_transfer',
      description:
        'Handles the case when the manager explicitly declines to connect to the caller.',
      parameters: z.object({
        reason: z
          .string()
          .describe('A short explanation of why the manager declined to connect to the caller'),
      }),
      flags: ToolFlag.IGNORE_ON_ENTER,
      execute: async ({ reason }: { reason: string }) => {
        setResult(new ToolError(`manager declined to connect: ${reason}`));
      },
    }),
    tool({
      name: 'voicemail_detected',
      description:
        'Called when the call reaches voicemail. Use this tool AFTER you hear the voicemail greeting',
      flags: ToolFlag.IGNORE_ON_ENTER,
      execute: async () => {
        setResult(new ToolError('voicemail detected'));
      },
    }),
  ];

  const task = AgentTask.create<WarmTransferResult>({
    instructions: resolveInstructions(instructions, chatCtx),
    turnDetection: turnDetection ?? undefined,
    tools: [...(tools ?? []), ...transferTools],
    stt: stt ?? undefined,
    vad: vad ?? undefined,
    llm: llm ?? undefined,
    tts: tts ?? undefined,
    allowInterruptions,
    onEnter: async () => {
      jobCtx = getJobContext();
      callerRoom = jobCtx.room;

      if (holdAudio !== null) {
        await backgroundAudio.start({ room: callerRoom });
        holdAudioHandle = backgroundAudio.play(holdAudio, true);
      }

      setIoEnabled(false);

      // Race the dial against a consultation-room failure. AbortController lets
      // the `finally` cancel a still-pending dial when the room dies first.
      const abortController = new AbortController();
      const dialPromise = dialManager(abortController.signal);
      try {
        const result = await Promise.race([
          dialPromise.then((session) => ({ session })),
          consultationFailedFut.await.then(() => ({ session: null })),
        ]);

        if (!result.session) {
          throw new Error('consultation room closed');
        }
        transferAgentSession = result.session;
      } catch (error) {
        logger.error({ error }, 'could not dial manager');
        setResult(new ToolError('could not dial manager'));
      } finally {
        abortController.abort();
        // If the dial won the race we kept its session; otherwise discard it.
        const session = await dialPromise.catch(() => null);
        if (session && transferAgentSession !== session) {
          await cleanupManagerDial(session, consultationRoom);
          consultationRoom = null;
        }
      }
    },
  });

  return task;
}

/**
 * Class wrapper around {@link createWarmTransferTask}, preserving the
 * `new WarmTransferTask(options).run()` API. It composes the functional task and
 * delegates `run()` to it.
 */
export class WarmTransferTask extends AgentTask<WarmTransferResult> {
  readonly #task: AgentTask<WarmTransferResult>;

  constructor(options: WarmTransferTaskOptions = {}) {
    // The wrapper itself never runs as an agent; run() delegates to the
    // composed task. Instructions are resolved inside createWarmTransferTask.
    super({ instructions: '' });
    this.#task = createWarmTransferTask(options);
  }

  override run(): Promise<WarmTransferResult> {
    return this.#task.run();
  }
}

const renderInstructionPart = (value: Instructions | string): string =>
  typeof value === 'string' ? value : value.value;

function resolveInstructions(
  instructions: InstructionParts | string | undefined,
  chatCtx: ChatContext | undefined,
): string {
  // A full instruction string replaces the built-in prompt entirely.
  if (typeof instructions === 'string') {
    return instructions;
  }

  // No instructions or an `InstructionParts` override: fill the built-in template.
  const parts: InstructionParts = instructions ?? { persona: PERSONA };
  // Single-pass replace via a callback: a chained `.replace(a, b)` would
  // interpret `$`-patterns in the substituted text and let an earlier
  // substitution swallow a later `{placeholder}`.
  const replacements: Record<string, string> = {
    // Unset preserves the built-in default; an explicit empty string removes the section.
    persona: parts.persona !== undefined ? renderInstructionPart(parts.persona) : PERSONA,
    _conversation_history: formatConversationHistory(chatCtx),
    extra: parts.extra !== undefined ? renderInstructionPart(parts.extra) : '',
  };
  return INSTRUCTIONS_TEMPLATE.replace(
    /\{(persona|_conversation_history|extra)\}/g,
    (_match, key: string) => replacements[key] ?? '',
  );
}

function formatConversationHistory(chatCtx?: ChatContext): string {
  if (!chatCtx) {
    return '';
  }

  let previousConversation = '';
  for (const item of chatCtx.items) {
    if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) {
      continue;
    }

    const content = item.textContent;
    if (!content) {
      continue;
    }

    const role = item.role === 'user' ? 'Caller' : 'Assistant';
    previousConversation += `${role}: ${content}\n`;
  }
  return previousConversation;
}

const PERSONA = `# Identity

You are an agent that is reaching out to a manager for help. There has been a previous conversation
between you and a caller, the conversation history is included below.

# Goal

Your main goal is to give the manager sufficient context about why the caller had called in,
so that the manager could gain sufficient knowledge to help the caller directly.`;

const INSTRUCTIONS_TEMPLATE = `{persona}

# Context

In the conversation, user refers to the manager, caller refers to the person who's transcript is included.
Remember, you are not speaking to the caller right now, you are speaking to the manager.

## Conversation history with caller
{_conversation_history}
## End of conversation history with caller

Once the manager has confirmed, you should call the tool \`connect_to_caller\` to connect them to the caller.

You are talking to the manager now, start by giving them a summary of the conversation so far, and answer any questions they might have.

{extra}
`;
