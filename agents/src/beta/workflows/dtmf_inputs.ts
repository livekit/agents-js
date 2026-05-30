// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
import { z } from 'zod';
import { getJobContext } from '../../job.js';
import type { ChatContext } from '../../llm/index.js';
import { ToolError, tool } from '../../llm/index.js';
import { AgentTask } from '../../voice/agent.js';
import { AgentSessionEventTypes } from '../../voice/events.js';
import type { AgentStateChangedEvent, UserStateChangedEvent } from '../../voice/events.js';
import { DtmfEvent, formatDtmf } from './utils.js';

type SipDtmfEvent = {
  digit: string;
};

export interface GetDtmfResult {
  userInput: string;
}

function getDtmfResult(dtmfInputs: DtmfEvent[]): GetDtmfResult {
  return { userInput: formatDtmf(dtmfInputs) };
}

export interface GetDtmfTaskOptions {
  numDigits: number;
  askForConfirmation?: boolean;
  dtmfInputTimeout?: number;
  dtmfStopEvent?: DtmfEvent;
  chatCtx?: ChatContext;
  extraInstructions?: string;
}

export class GetDtmfTask extends AgentTask<GetDtmfResult> {
  private currentDtmfInputs: DtmfEvent[] = [];
  private isDtmfReplyRunning = false;
  private generateDtmfReplyTimer?: NodeJS.Timeout;

  private readonly numDigits: number;
  private readonly askForConfirmation: boolean;
  private readonly dtmfInputTimeout: number;
  private readonly dtmfStopEvent: DtmfEvent;

  private readonly onSipDtmfReceived = (ev: SipDtmfEvent): void => {
    if (this.isDtmfReplyRunning) {
      return;
    }

    if (ev.digit === this.dtmfStopEvent) {
      void this.generateDtmfReplyNow();
      return;
    }

    this.currentDtmfInputs.push(ev.digit as DtmfEvent);
    this.scheduleGenerateDtmfReply();
  };

  private readonly onUserStateChanged = (ev: UserStateChangedEvent): void => {
    if (this.dtmfReplyRunning()) {
      return;
    }

    if (ev.newState === 'speaking') {
      this.cancelGenerateDtmfReply();
    } else if (this.currentDtmfInputs.length !== 0) {
      this.scheduleGenerateDtmfReply();
    }
  };

  private readonly onAgentStateChanged = (ev: AgentStateChangedEvent): void => {
    if (this.dtmfReplyRunning()) {
      return;
    }

    if (ev.newState === 'speaking' || ev.newState === 'thinking') {
      this.cancelGenerateDtmfReply();
    } else if (this.currentDtmfInputs.length !== 0) {
      this.scheduleGenerateDtmfReply();
    }
  };

  constructor(options: GetDtmfTaskOptions) {
    const {
      numDigits,
      askForConfirmation = false,
      dtmfInputTimeout = 4000,
      dtmfStopEvent = DtmfEvent.POUND,
      chatCtx,
      extraInstructions,
    } = options;

    if (numDigits <= 0) {
      throw new Error('numDigits must be greater than 0');
    }

    const dtmfInputsSchema = z.array(z.nativeEnum(DtmfEvent));

    const confirmInputs = tool({
      description:
        'Finalize the collected digit inputs after explicit user confirmation. ' +
        'Use this ONLY after the confirmation. You should confirm by verbally reading out the digits one by one and, once the user confirms they are correct, call this tool with the inputs. ' +
        'Do not use this tool to capture the initial digits.',
      parameters: z.object({ inputs: dtmfInputsSchema }),
      execute: async ({ inputs }: { inputs: DtmfEvent[] }) => {
        this.complete(getDtmfResult(inputs));
      },
    });

    const recordInputs = tool({
      description:
        'Record the collected digit inputs without additional confirmation. ' +
        'Call this tool as soon as a valid sequence of digits has been provided by the user (via DTMF or spoken).',
      parameters: z.object({ inputs: dtmfInputsSchema }),
      execute: async ({ inputs }: { inputs: DtmfEvent[] }) => {
        this.complete(getDtmfResult(inputs));
      },
    });

    let instructions =
      'You are a single step in a broader system, responsible solely for gathering digits input from the user. ' +
      'You will either receive a sequence of digits through dtmf events tagged by <dtmf_inputs>, or ' +
      'user will directly say the digits to you. You should be able to handle both cases. ';

    if (askForConfirmation) {
      instructions +=
        'Once user has confirmed the digits (by verbally spoken or entered manually), call `confirm_inputs` with the inputs.';
    } else {
      instructions +=
        'If user provides the digits through voice and it is valid, call `record_inputs` with the inputs.';
    }

    if (extraInstructions !== undefined) {
      instructions += `\n${extraInstructions}`;
    }

    super({
      instructions,
      chatCtx,
      tools: askForConfirmation
        ? { confirm_inputs: confirmInputs }
        : { record_inputs: recordInputs },
    });

    this.numDigits = numDigits;
    this.askForConfirmation = askForConfirmation;
    this.dtmfInputTimeout = dtmfInputTimeout;
    this.dtmfStopEvent = dtmfStopEvent;
  }

  dtmfReplyRunning(): boolean {
    return this.isDtmfReplyRunning;
  }

  async onEnter(): Promise<void> {
    const ctx = getJobContext();

    this.roomOn(ctx.room, 'sip_dtmf_received', this.onSipDtmfReceived);
    this.session.on(AgentSessionEventTypes.UserStateChanged, this.onUserStateChanged);
    this.session.on(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);
    this.session.generateReply({ toolChoice: 'none' });
  }

  async onExit(): Promise<void> {
    const ctx = getJobContext();

    this.roomOff(ctx.room, 'sip_dtmf_received', this.onSipDtmfReceived);
    this.session.off(AgentSessionEventTypes.UserStateChanged, this.onUserStateChanged);
    this.session.off(AgentSessionEventTypes.AgentStateChanged, this.onAgentStateChanged);
    this.cancelGenerateDtmfReply();
  }

  private scheduleGenerateDtmfReply(): void {
    this.cancelGenerateDtmfReply();
    this.generateDtmfReplyTimer = setTimeout(() => {
      void this.generateDtmfReplyNow();
    }, this.dtmfInputTimeout);
  }

  private cancelGenerateDtmfReply(): void {
    if (this.generateDtmfReplyTimer) {
      clearTimeout(this.generateDtmfReplyTimer);
      this.generateDtmfReplyTimer = undefined;
    }
  }

  private async generateDtmfReplyNow(): Promise<void> {
    this.cancelGenerateDtmfReply();
    this.isDtmfReplyRunning = true;

    try {
      this.session.interrupt();

      const dtmfStr = formatDtmf(this.currentDtmfInputs);
      if (this.currentDtmfInputs.length !== this.numDigits) {
        this.complete(
          new ToolError(
            `Digits input not fully received. Expect ${this.numDigits} digits, got ${this.currentDtmfInputs.length}`,
          ),
        );
        return;
      }

      if (!this.askForConfirmation) {
        this.complete(getDtmfResult(this.currentDtmfInputs));
        return;
      }

      const instructions =
        'User has entered the following valid digits on the telephone keypad:\n' +
        `<dtmf_inputs>${dtmfStr}</dtmf_inputs>\n` +
        'Please confirm it with the user by saying the digits one by one with space in between ' +
        "(.e.g. 'one two three four five six seven eight nine ten'). " +
        'Once you are sure, call `confirm_inputs` with the inputs.';

      this.session.generateReply({ userInput: instructions });
    } finally {
      this.isDtmfReplyRunning = false;
      this.currentDtmfInputs = [];
    }
  }

  private roomOn(room: Room, event: string, listener: (ev: SipDtmfEvent) => void): void {
    room.on(event as never, listener as never);
  }

  private roomOff(room: Room, event: string, listener: (ev: SipDtmfEvent) => void): void {
    room.off(event as never, listener as never);
  }
}
