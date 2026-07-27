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
  humanAgentIdentity: string;
}

export interface WarmTransferTaskOptions {
  /** The phone number or SIP URI to dial for the human agent. */
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
   * DTMF tones to send once the human agent's call is answered, e.g. to dial an extension or
   * navigate an IVR menu (`'1234#'`). Insert `w` characters to pause ~0.5s each before/between
   * digits (`'wwww1234#'` waits ~2s, useful when the destination plays a greeting before
   * accepting input).
   */
  dtmf?: string | null;
  /**
   * How long to wait, in milliseconds, for the human agent to answer before giving up. The
   * underlying SIP API only supports whole-second granularity, so the value is rounded to the
   * nearest second.
   */
  ringingTimeout?: number | null;
  /**
   * Name of the room used to dial and brief the human agent. Defaults to
   * `${callerRoom.name}-human-agent`.
   *
   * Set this to control the briefing room's configuration: pre-create a room
   * under this name (e.g. with `RoomServiceClient.createRoom` and an `egress`
   * request to record the transfer leg) before running the task, and the
   * transfer agent joins the pre-configured room instead of implicitly
   * creating one with project defaults.
   *
   * The room is deleted when the transfer completes, fails, or is cancelled
   * (the same lifecycle as the default room), which also ends any egress
   * attached to it. Must differ from the caller room's name.
   */
  roomName?: string;
  /** Audio played to the caller while they are on hold during the transfer. */
  holdAudio?: AudioSourceType | AudioConfig | AudioConfig[] | null;
  /**
   * Instructions used to generate the reply spoken to the human agent before their call is
   * ended when the caller hangs up mid-transfer (after the human agent answered but before
   * the merge). Falls back to a built-in instruction when not provided.
   */
  callerHangupInstruction?: string | null;
  /**
   * Instructions for the human agent briefing. Pass a full string to replace the built-in prompt
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
 * Build a warm-transfer {@link AgentTask} that dials a human agent over SIP, briefs them
 * in a private room, and (on confirmation) merges them into the caller room.
 *
 * If the caller hangs up before the merge — including while the human agent's phone is
 * still ringing — the transfer is cancelled: the pending dial is aborted, the human agent
 * room is torn down (ending the SIP call), and the task completes with a {@link ToolError}.
 * A human agent who already answered is told the caller left (a reply generated from
 * {@link WarmTransferTaskOptions.callerHangupInstruction}) before their call is ended.
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
  roomName: rawRoomName,
  holdAudio = { source: BuiltinAudioClip.HOLD_MUSIC, volume: 0.8 },
  callerHangupInstruction,
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

  if (rawRoomName !== undefined && rawRoomName.length === 0) {
    throw new Error('`roomName` must not be empty');
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

  const humanAgentIdentity = 'human-agent-sip';
  const backgroundAudio = new BackgroundAudioPlayer();
  const logger = log();

  // Mutable state shared between the onEnter hook and the tools below. A closure
  // keeps it private to this task instance without the field-initializer ordering
  // pitfalls of a class.
  let callerRoom: Room | null = null;
  let humanAgentRoom: Room | null = null;
  // Captured eagerly in onEnter while the live job context is available. The
  // post-merge caller-room cleanup listener fires from a native rtc-node FFI
  // callback whose AsyncLocalStorage context is pinned to FfiClient-singleton
  // creation, so getJobContext() would read an empty/stale store there.
  let jobCtx: JobContext | null = null;
  let transferAgentSession: AgentSession | null = null;
  // Session handed off to the caller-hangup notification flow, which owns its
  // teardown from that point on — no other cleanup path may close it.
  let hangupNotifySession: AgentSession | null = null;
  let holdAudioHandle: PlayHandle | null = null;
  let originalIoState: IoState | null = null;

  // Resolves when the human agent room/session fails, so onEnter stops waiting.
  const humanAgentFailedFut = new Future<void>();
  // Resolves when the caller hangs up before the merge, so onEnter cancels a
  // still-pending dial (e.g. while the human agent's phone is ringing).
  const callerHangupFut = new Future<void>();

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

    // Every completion path (merge, decline, voicemail, failure, hangup) ends
    // the pre-merge hangup watch; connect_to_caller re-attaches its own
    // post-merge cleanup listener.
    callerRoom?.off(RoomEvent.ParticipantDisconnected, onCallerLeftBeforeMerge);

    if (transferAgentSession) {
      // shutdown() triggers deleteRoomOnClose, which disconnects the human agent
      // room and frees its WebSocket. The human agent is already moved out
      // (mergeCalls) or torn down (failure) by now.
      transferAgentSession.shutdown();
      transferAgentSession = null;
      humanAgentRoom = null;
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

  const onHumanAgentRoomClose = (reason: DisconnectReason): void => {
    logger.debug({ reason }, 'human agent room closed');
    humanAgentFailedFut.resolve();
    setResult(new ToolError(`room closed: ${reason}`));
  };

  const hasCallerParticipant = (): boolean => {
    if (!callerRoom) return false;
    for (const participant of callerRoom.remoteParticipants.values()) {
      if (DEFAULT_PARTICIPANT_KINDS.includes(participant.kind)) {
        return true;
      }
    }
    return false;
  };

  // Announces the caller hangup to the human agent, then hangs up on them by
  // shutting the session down (deleteRoomOnClose ends the SIP call).
  const notifyHumanAgentOfHangup = async (session: AgentSession): Promise<void> => {
    try {
      session.interrupt();
      const handle = session.generateReply({
        instructions: callerHangupInstruction ?? CALLER_HANGUP_INSTRUCTION,
        allowInterruptions: false,
        // The transfer is already cancelled; the reply must speak, not call
        // connect_to_caller/decline_transfer.
        toolChoice: 'none',
      });
      // Cap the wait so teardown can't hang on a stuck playout.
      await waitUntilAborted(handle.waitForPlayout(), AbortSignal.timeout(10_000));
    } catch (error) {
      logger.warn({ error }, 'failed to notify human agent of caller hangup');
    } finally {
      session.shutdown();
    }
  };

  const cancelForCallerHangup = (participantIdentity?: string): void => {
    if (task.done) return;
    logger.info(
      { participantIdentity },
      'caller hung up before the transfer completed, cancelling transfer',
    );
    callerHangupFut.resolve();

    // If the human agent already answered, take the session out of setResult's
    // reach and let them know before hanging up, instead of dropping the call
    // on them mid-briefing.
    const session = transferAgentSession;
    if (session) {
      transferAgentSession = null;
      humanAgentRoom = null;
      hangupNotifySession = session;
      void notifyHumanAgentOfHangup(session);
    }
    setResult(new ToolError('caller hung up before the transfer completed'));
  };

  // Pre-merge watch: cancels the transfer if the caller leaves while the human
  // agent's phone is still ringing or they're being briefed. Without it the
  // dial keeps going and the human agent gets merged into an empty room.
  const onCallerLeftBeforeMerge = (participant: {
    identity: string;
    kind: ParticipantKind;
  }): void => {
    if (!DEFAULT_PARTICIPANT_KINDS.includes(participant.kind)) {
      return;
    }
    cancelForCallerHangup(participant.identity);
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

  const cleanupHumanAgentDial = async (
    session?: AgentSession | null,
    room?: Room | null,
  ): Promise<void> => {
    await room?.disconnect().catch((error) => {
      logger.warn({ error }, 'failed to disconnect human agent room');
    });
    await session?.close().catch((error) => {
      logger.warn({ error }, 'failed to close transfer agent session');
    });
  };

  const mergeCalls = async (): Promise<void> => {
    if (!callerRoom?.name || !humanAgentRoom?.name) {
      throw new Error('calls are not ready to merge');
    }

    humanAgentRoom.off(RoomEvent.Disconnected, onHumanAgentRoomClose);

    logger.debug(
      { humanAgentIdentity, callerRoom: callerRoom.name },
      'moving human agent to caller room',
    );

    const info = (jobCtx ?? getJobContext()).info;
    const rooms = new RoomServiceClient(info.url, info.apiKey, info.apiSecret);
    await rooms.moveParticipant(humanAgentRoom.name, humanAgentIdentity, callerRoom.name);
  };

  /**
   * Dials the human agent into a fresh room and starts a copy of this
   * task there. Every awaited step is raced against `signal`; on abort the
   * `finally` block tears the half-built room/session down (the room/SIP SDK
   * calls themselves aren't AbortSignal-aware).
   */
  const dialHumanAgent = async (signal: AbortSignal): Promise<AgentSession> => {
    if (!callerRoom?.name) {
      throw new Error('caller room is not available');
    }
    const localIdentity = callerRoom.localParticipant?.identity;
    if (!localIdentity) {
      throw new Error('caller room local participant is not available');
    }

    const ctx = jobCtx ?? getJobContext();
    const humanAgentRoomName = resolveHumanAgentRoomName(callerRoom.name, rawRoomName);
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
        room: humanAgentRoomName,
        canUpdateOwnMetadata: true,
        canPublish: true,
        canSubscribe: true,
      } as VideoGrant);

      logger.debug({ wsUrl: ctx.info.url, humanAgentRoomName }, 'connecting to human agent room');
      const jwt = await token.toJwt();

      room.on(RoomEvent.Disconnected, onHumanAgentRoomClose);

      const connected = await waitUntilAborted(room.connect(ctx.info.url, jwt), signal);
      if (connected.isAborted) {
        throw new Error('dial cancelled');
      }

      // The human agent session reuses the caller session's models.
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
            // Delete the human agent room on shutdown so its WebSocket doesn't
            // leak across transfers.
            deleteRoomOnClose: true,
            participantIdentity: humanAgentIdentity,
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
          humanAgentRoomName,
          {
            participantIdentity: humanAgentIdentity,
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

      humanAgentRoom = room;
      completed = true;
      return session;
    } finally {
      if (!completed) {
        room.off(RoomEvent.Disconnected, onHumanAgentRoomClose);
        await cleanupHumanAgentDial(session, room);
      }
    }
  };

  const transferTools: ToolContextEntry[] = [
    tool({
      name: 'connect_to_caller',
      description: 'Called when the human agent wants to connect to the caller.',
      flags: ToolFlag.IGNORE_ON_ENTER,
      execute: async () => {
        logger.debug('connecting to caller');
        if (!callerRoom) {
          throw new Error('caller room is not available');
        }
        if (task.done) {
          // e.g. the caller hung up while the human agent was confirming;
          // don't move them into an empty room.
          throw new ToolError('the transfer was already cancelled');
        }

        await mergeCalls();
        setResult({ humanAgentIdentity });
        callerRoom.on(RoomEvent.ParticipantDisconnected, onCallerParticipantDisconnected);
      },
    }),
    tool({
      name: 'decline_transfer',
      description:
        'Handles the case when the human agent explicitly declines to connect to the caller.',
      parameters: z.object({
        reason: z
          .string()
          .describe('A short explanation of why the human agent declined to connect to the caller'),
      }),
      flags: ToolFlag.IGNORE_ON_ENTER,
      execute: async ({ reason }: { reason: string }) => {
        setResult(new ToolError(`human agent declined to connect: ${reason}`));
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

      callerRoom.on(RoomEvent.ParticipantDisconnected, onCallerLeftBeforeMerge);
      if (!hasCallerParticipant()) {
        // The caller was already gone before the listener could attach.
        cancelForCallerHangup();
        return;
      }

      if (holdAudio !== null) {
        await backgroundAudio.start({ room: callerRoom });
        if (task.done) {
          // The caller hung up while the hold audio was starting; setResult
          // already closed the player, so don't create an orphaned play handle.
          return;
        }
        holdAudioHandle = backgroundAudio.play(holdAudio, true);
      }

      setIoEnabled(false);

      // Race the dial against a human-agent-room failure or a caller hangup.
      // AbortController lets the `finally` cancel a still-pending dial when
      // either of those wins the race.
      const abortController = new AbortController();
      const dialPromise = dialHumanAgent(abortController.signal);
      try {
        const result = await Promise.race([
          dialPromise.then((session) => ({ session, callerHungUp: false })),
          humanAgentFailedFut.await.then(() => ({ session: null, callerHungUp: false })),
          callerHangupFut.await.then(() => ({ session: null, callerHungUp: true })),
        ]);

        if (result.callerHungUp) {
          // cancelForCallerHangup already completed the task; the `finally`
          // below aborts the pending dial and tears down the half-built room.
          return;
        }
        if (!result.session) {
          throw new Error('human agent room closed');
        }
        if (task.done) {
          // The caller hung up in the same tick the dial completed; leave
          // `transferAgentSession` unset so the `finally` discards the session.
          return;
        }
        transferAgentSession = result.session;
      } catch (error) {
        logger.error({ error }, 'could not dial human agent');
        setResult(new ToolError('could not dial human agent'));
      } finally {
        abortController.abort();
        // If the dial won the race we kept its session; if the hangup-notify
        // flow took it, that flow shuts it down; otherwise discard it.
        const session = await dialPromise.catch(() => null);
        if (session && transferAgentSession !== session && hangupNotifySession !== session) {
          await cleanupHumanAgentDial(session, humanAgentRoom);
          humanAgentRoom = null;
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

/**
 * Resolve the name of the room used to dial and brief the human agent.
 *
 * Exported for testing; not re-exported from the package index.
 */
export function resolveHumanAgentRoomName(callerRoomName: string, override?: string): string {
  if (override === undefined) {
    return `${callerRoomName}-human-agent`;
  }
  if (override === callerRoomName) {
    throw new Error('`roomName` must differ from the caller room name');
  }
  return override;
}

const CALLER_HANGUP_INSTRUCTION = `The caller has hung up before the transfer could be completed.
Briefly inform the human agent that the caller has left and that you are ending the call now.`;

const PERSONA = `# Identity

You are an agent that is reaching out to a human agent for help. There has been a previous conversation
between you and a caller, the conversation history is included below.

# Goal

Your main goal is to give the human agent sufficient context about why the caller had called in,
so that the human agent could gain sufficient knowledge to help the caller directly.`;

const INSTRUCTIONS_TEMPLATE = `{persona}

# Context

In the conversation, user refers to the human agent, caller refers to the person who's transcript is included.
Remember, you are not speaking to the caller right now, you are speaking to the human agent.

## Conversation history with caller
{_conversation_history}
## End of conversation history with caller

Once the human agent has confirmed, you should call the tool \`connect_to_caller\` to connect them to the caller.

You are talking to the human agent now, start by giving them a summary of the conversation so far, and answer any questions they might have.

{extra}
`;
