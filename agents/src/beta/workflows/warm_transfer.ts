// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { SIPOutboundConfig } from '@livekit/protocol';
import { type DisconnectReason, ParticipantKind, Room, RoomEvent } from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient, SipClient, type VideoGrant } from 'livekit-server-sdk';
import { z } from 'zod';
import { getJobContext } from '../../job.js';
import type { ChatContext, ToolContext } from '../../llm/index.js';
import { ToolError, ToolFlag, tool } from '../../llm/index.js';
import { log } from '../../log.js';
import { Agent, type AgentOptions, AgentTask } from '../../voice/agent.js';
import { AgentSession, type TurnDetectionMode } from '../../voice/agent_session.js';
import {
  type AudioConfig,
  type AudioSourceType,
  BackgroundAudioPlayer,
  BuiltinAudioClip,
  type PlayHandle,
} from '../../voice/background_audio.js';

const DEFAULT_PARTICIPANT_KINDS = [
  ParticipantKind.CONNECTOR,
  ParticipantKind.SIP,
  ParticipantKind.STANDARD,
];

export interface WarmTransferResult {
  humanAgentIdentity: string;
}

export interface InstructionParts {
  persona?: string;
  extra?: string;
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
  /** Audio played to the caller while they are on hold during the transfer. */
  holdAudio?: AudioSourceType | AudioConfig | AudioConfig[] | null;
  instructions?: InstructionParts | string;
  chatCtx?: ChatContext;
  turnDetection?: TurnDetectionMode | null;
  tools?: ToolContext;
  stt?: AgentOptions<unknown>['stt'] | null;
  vad?: AgentOptions<unknown>['vad'] | null;
  llm?: AgentOptions<unknown>['llm'] | null;
  tts?: AgentOptions<unknown>['tts'] | null;
  allowInterruptions?: boolean;
  /** @deprecated use `sipCallTo` instead. */
  targetPhoneNumber?: string;
  /** @deprecated use `instructions.extra` instead. */
  extraInstructions?: string;
}

export class WarmTransferTask extends AgentTask<WarmTransferResult> {
  private _callerRoom: Room | null = null;
  private _humanAgentRoom: Room | null = null;
  private _humanAgentSession: AgentSession | null = null;
  private _humanAgentFailed = new Promise<void>((resolve) => {
    this._resolveHumanAgentFailed = resolve;
  });
  private _resolveHumanAgentFailed!: () => void;
  private _humanAgentIdentity = 'human-agent-sip';

  private _sipCallTo: string;
  private _sipTrunkId: string | null;
  private _sipConnection?: SIPOutboundConfig;
  private _sipNumber: string;
  private _sipHeaders: Record<string, string>;

  private _backgroundAudio = new BackgroundAudioPlayer();
  private _holdAudioHandle: PlayHandle | null = null;
  private _holdAudio: AudioSourceType | AudioConfig | AudioConfig[] | null;

  private _originalIoState: Record<string, boolean> = {};
  private _taskTurnDetection: TurnDetectionMode | undefined;
  private _allowInterruptions: boolean | undefined;
  private _logger = log();

  constructor(options: WarmTransferTaskOptions = {}) {
    let sipCallTo = options.sipCallTo;
    let instructions = options.instructions;
    const {
      sipTrunkId,
      sipConnection,
      sipNumber,
      sipHeaders,
      holdAudio,
      chatCtx,
      turnDetection,
      tools,
      stt,
      vad,
      llm,
      tts,
      allowInterruptions,
      targetPhoneNumber,
      extraInstructions = '',
    } = options;

    if (targetPhoneNumber) {
      log().warn('`targetPhoneNumber` is deprecated, use `sipCallTo` instead');
      sipCallTo ??= targetPhoneNumber;
    }

    if (!sipCallTo) {
      throw new Error('`sipCallTo` must be set');
    }

    if (!instructions) {
      instructions = { persona: PERSONA, extra: extraInstructions };
    } else if (extraInstructions) {
      log().warn('`extraInstructions` will be ignored when `instructions` is provided');
    }

    if (typeof instructions !== 'string') {
      instructions = INSTRUCTIONS_TEMPLATE.replace('{persona}', instructions.persona ?? PERSONA)
        .replace('{_conversation_history}', WarmTransferTask.formatConversationHistory(chatCtx))
        .replace('{extra}', instructions.extra ?? '');
    }

    super({
      instructions,
      turnDetection: turnDetection ?? undefined,
      tools,
      stt: stt ?? undefined,
      vad: vad ?? undefined,
      llm: llm ?? undefined,
      tts: tts ?? undefined,
      allowInterruptions,
    });

    this._tools = {
      ...this._tools,
      connect_to_caller: this.buildConnectToCallerTool(),
      decline_transfer: this.buildDeclineTransferTool(),
      voicemail_detected: this.buildVoicemailDetectedTool(),
    };
    this._chatCtx = this._chatCtx.copy({ toolCtx: this._tools });

    this._taskTurnDetection = turnDetection ?? undefined;
    this._allowInterruptions = allowInterruptions;

    this._sipCallTo = sipCallTo;
    this._sipConnection = sipConnection;
    if (sipTrunkId !== undefined) {
      this._sipTrunkId = sipTrunkId;
    } else if (this._sipConnection) {
      this._sipTrunkId = null;
    } else {
      this._sipTrunkId = process.env.LIVEKIT_SIP_OUTBOUND_TRUNK ?? null;
    }
    if (this._sipTrunkId === null && !this._sipConnection) {
      throw new Error(
        '`LIVEKIT_SIP_OUTBOUND_TRUNK` environment variable, `sipTrunkId`, or `sipConnection` must be set',
      );
    }

    this._sipNumber = sipNumber ?? process.env.LIVEKIT_SIP_NUMBER ?? '';
    this._sipHeaders = sipHeaders ?? {};
    this._holdAudio =
      holdAudio === undefined
        ? { source: BuiltinAudioClip.OFFICE_AMBIENCE, volume: 0.8 }
        : holdAudio;
  }

  private static formatConversationHistory(chatCtx?: ChatContext): string {
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

  async onEnter(): Promise<void> {
    const jobCtx = getJobContext();
    this._callerRoom = jobCtx.room;

    if (this._holdAudio !== null) {
      await this._backgroundAudio.start({ room: this._callerRoom });
      this._holdAudioHandle = this._backgroundAudio.play(this._holdAudio, true);
    }

    this.setIoEnabled(false);

    const dialHumanAgent = this.dialHumanAgent();
    try {
      const result = await Promise.race([
        dialHumanAgent.then((session) => ({ session })),
        this._humanAgentFailed.then(() => ({ session: null })),
      ]);

      if (!result.session) {
        throw new Error('human agent room closed');
      }

      this._humanAgentSession = result.session;
    } catch (error) {
      this._logger.error({ error }, 'could not dial human agent');
      this.setResult(new ToolError('could not dial human agent'));
    }
  }

  private buildConnectToCallerTool() {
    return tool({
      description: 'Called when the human agent wants to connect to the caller.',
      flags: ToolFlag.IGNORE_ON_ENTER,
      execute: async () => {
        this._logger.debug('connecting to caller');
        if (!this._callerRoom) {
          throw new Error('caller room is not available');
        }

        await this.mergeCalls();
        this.setResult({ humanAgentIdentity: this._humanAgentIdentity });
        this._callerRoom.on(
          RoomEvent.ParticipantDisconnected,
          this.onCallerParticipantDisconnected,
        );
      },
    });
  }

  private buildDeclineTransferTool() {
    return tool({
      description:
        'Handles the case when the human agent explicitly declines to connect to the caller.',
      parameters: z.object({
        reason: z
          .string()
          .describe('A short explanation of why the human agent declined to connect to the caller'),
      }),
      flags: ToolFlag.IGNORE_ON_ENTER,
      execute: async ({ reason }: { reason: string }) => {
        this.setResult(new ToolError(`human agent declined to connect: ${reason}`));
      },
    });
  }

  private buildVoicemailDetectedTool() {
    return tool({
      description:
        'Called when the call reaches voicemail. Use this tool AFTER you hear the voicemail greeting',
      flags: ToolFlag.IGNORE_ON_ENTER,
      execute: async () => {
        this.setResult(new ToolError('voicemail detected'));
      },
    });
  }

  private onHumanAgentRoomClose = (reason: DisconnectReason): void => {
    this._logger.debug({ reason }, "human agent's room closed");
    this._resolveHumanAgentFailed();
    this.setResult(new ToolError(`room closed: ${reason}`));
  };

  private onCallerParticipantDisconnected = (participant: {
    identity: string;
    kind: ParticipantKind;
  }): void => {
    if (!DEFAULT_PARTICIPANT_KINDS.includes(participant.kind)) {
      return;
    }

    this._logger.info(
      { participantIdentity: participant.identity },
      'participant disconnected from caller room, closing',
    );

    if (!this._callerRoom?.name) {
      return;
    }

    this._callerRoom.off(RoomEvent.ParticipantDisconnected, this.onCallerParticipantDisconnected);

    const rooms = new RoomServiceClient(getJobContext().info.url);
    void rooms.deleteRoom(this._callerRoom.name).catch((error) => {
      this._logger.warn({ error }, 'failed to delete caller room');
    });
  };

  private setResult(result: WarmTransferResult | Error): void {
    if (this.done) {
      return;
    }

    if (this._humanAgentSession) {
      this._humanAgentSession.shutdown({ drain: false });
      this._humanAgentSession = null;
    }

    if (this._holdAudioHandle) {
      this._holdAudioHandle.stop();
      this._holdAudioHandle = null;
    }
    void this._backgroundAudio.close().catch((error) => {
      this._logger.warn({ error }, 'failed to close background audio');
    });

    this.setIoEnabled(true);
    this.complete(result);
  }

  private async dialHumanAgent(): Promise<AgentSession> {
    if (!this._callerRoom?.name) {
      throw new Error('caller room is not available');
    }
    const localIdentity = this._callerRoom.localParticipant?.identity;
    if (!localIdentity) {
      throw new Error('caller room local participant is not available');
    }

    const jobCtx = getJobContext();
    const humanAgentRoomName = `${this._callerRoom.name}-human-agent`;
    const room = new Room();
    const token = new AccessToken(undefined, undefined, { identity: localIdentity });
    token.kind = 'agent';
    token.addGrant({
      roomJoin: true,
      room: humanAgentRoomName,
      canUpdateOwnMetadata: true,
      canPublish: true,
      canSubscribe: true,
    } as VideoGrant);

    this._logger.debug(
      { wsUrl: jobCtx.info.url, humanAgentRoomName },
      'connecting to human agent room',
    );
    await room.connect(jobCtx.info.url, await token.toJwt());
    room.on(RoomEvent.Disconnected, this.onHumanAgentRoomClose);

    const humanAgentSession = new AgentSession({
      vad: this.session.vad,
      llm: this.session.llm,
      stt: this.session.stt,
      tts: this.session.tts,
      turnDetection: this.session.turnDetection,
    });
    const humanAgent = new Agent({
      instructions: this.instructions,
      stt: this.stt,
      vad: this.vad,
      llm: this.llm,
      tts: this.tts,
      tools: this.toolCtx,
      chatCtx: this._chatCtx.copy(),
      turnDetection: this._taskTurnDetection,
      allowInterruptions: this._allowInterruptions,
    });

    await humanAgentSession.start({
      agent: humanAgent,
      room,
      inputOptions: {
        closeOnDisconnect: true,
        participantIdentity: this._humanAgentIdentity,
      },
      record: false,
    });

    const sip = new SipClient(jobCtx.info.url);
    await sip.createSipParticipant(
      this._sipTrunkId ?? '',
      this._sipCallTo,
      humanAgentRoomName,
      {
        participantIdentity: this._humanAgentIdentity,
        waitUntilAnswered: true,
        fromNumber: this._sipNumber || undefined,
        headers: this._sipHeaders,
      },
      this._sipConnection,
    );

    this._humanAgentRoom = room;
    return humanAgentSession;
  }

  private async mergeCalls(): Promise<void> {
    if (!this._callerRoom?.name || !this._humanAgentRoom?.name) {
      throw new Error('calls are not ready to merge');
    }

    this._humanAgentRoom.off(RoomEvent.Disconnected, this.onHumanAgentRoomClose);

    this._logger.debug(
      { humanAgentIdentity: this._humanAgentIdentity, callerRoom: this._callerRoom.name },
      'moving human agent to caller room',
    );

    const rooms = new RoomServiceClient(getJobContext().info.url);
    await rooms.moveParticipant(
      this._humanAgentRoom.name,
      this._humanAgentIdentity,
      this._callerRoom.name,
    );
  }

  private setIoEnabled(enabled: boolean): void {
    const input = this.session.input;
    const output = this.session.output;

    if (Object.keys(this._originalIoState).length === 0) {
      this._originalIoState = {
        audioInput: input.audioEnabled,
        audioOutput: output.audioEnabled,
        transcriptionOutput: output.transcriptionEnabled,
      };
    }

    if (input.audio) {
      input.setAudioEnabled(enabled && this._originalIoState.audioInput!);
    }
    if (output.audio) {
      output.setAudioEnabled(enabled && this._originalIoState.audioOutput!);
    }
    if (output.transcription) {
      output.setTranscriptionEnabled(enabled && this._originalIoState.transcriptionOutput!);
    }
  }
}

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
