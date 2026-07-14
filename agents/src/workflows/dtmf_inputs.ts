// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { RoomEvent } from '@livekit/rtc-node';
import { z } from 'zod';
import { getJobContext } from '../job.js';
import type { ChatContext } from '../llm/index.js';
import { ToolError, tool } from '../llm/index.js';
import { log } from '../log.js';
import { AgentTask } from '../voice/agent.js';
import {
  AgentSessionEventTypes,
  type AgentStateChangedEvent,
  type UserStateChangedEvent,
} from '../voice/events.js';
import { DtmfEvent, formatDtmf } from './utils.js';

export interface GetDtmfResult {
  userInput: string;
}

export interface GetDtmfTaskOptions {
  /** The number of digits to collect. */
  numDigits: number;
  /** Whether to ask for confirmation when the agent has collected the full digits. */
  askForConfirmation?: boolean;
  /** The per-digit timeout, in milliseconds. Defaults to 4000. */
  dtmfInputTimeout?: number;
  /** The DTMF event that stops collecting inputs. Defaults to `DtmfEvent.POUND`. */
  dtmfStopEvent?: DtmfEvent;
  /** The chat context to use. */
  chatCtx?: ChatContext;
  /** Extra instructions to add to the task. */
  extraInstructions?: string;
}

/**
 * Debounced runner for a single async function: `schedule()` (re)starts a delay timer,
 * `run()` fires immediately, `cancel()` clears any pending timer. Mirrors the Python
 * `utils.aio.debounced` helper closely enough for this task's needs.
 */
class Debounced {
  #timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly fn: () => Promise<void>,
    private readonly delay: number,
  ) {}

  schedule(): void {
    this.cancel();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#run();
    }, this.delay);
  }

  run(): void {
    this.cancel();
    this.#run();
  }

  cancel(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #run(): void {
    void this.fn().catch((error) => {
      log().error({ error }, 'error running debounced DTMF reply');
    });
  }
}

const dtmfResultFromInputs = (inputs: readonly DtmfEvent[]): GetDtmfResult => ({
  userInput: formatDtmf(inputs),
});

/**
 * Build an {@link AgentTask} that collects DTMF inputs from the user.
 *
 * The task completes with the collected digit string, or fails with a {@link ToolError}
 * when the expected number of digits is not received in time.
 *
 * This is the functional core; {@link GetDtmfTask} is a thin class wrapper over it.
 */
export function createGetDtmfTask({
  numDigits,
  askForConfirmation = false,
  dtmfInputTimeout = 4000,
  dtmfStopEvent = DtmfEvent.POUND,
  chatCtx,
  extraInstructions,
}: GetDtmfTaskOptions): AgentTask<GetDtmfResult> {
  if (numDigits <= 0) {
    throw new Error('numDigits must be greater than 0');
  }

  const logger = log().child({ component: 'dtmf-inputs' });

  const currDtmfInputs: DtmfEvent[] = [];
  let dtmfReplyRunning = false;

  const confirmInputsTool = tool({
    name: 'confirm_inputs',
    description:
      'Finalize the collected digit inputs after explicit user confirmation.\n\n' +
      'Use this ONLY after the confirmation. You should confirm by verbally reading out the digits one by one and, once the ' +
      'user confirms they are correct, call this tool with the inputs.\n\n' +
      'Do not use this tool to capture the initial digits.',
    parameters: z.object({
      inputs: z.array(z.nativeEnum(DtmfEvent)).describe('The digit inputs to finalize'),
    }),
    execute: async ({ inputs }: { inputs: DtmfEvent[] }) => {
      task.complete(dtmfResultFromInputs(inputs));
    },
  });

  const recordInputsTool = tool({
    name: 'record_inputs',
    description:
      'Record the collected digit inputs without additional confirmation.\n\n' +
      'Call this tool as soon as a valid sequence of digits has been provided by the user (via DTMF or spoken).',
    parameters: z.object({
      inputs: z.array(z.nativeEnum(DtmfEvent)).describe('The digit inputs to record'),
    }),
    execute: async ({ inputs }: { inputs: DtmfEvent[] }) => {
      task.complete(dtmfResultFromInputs(inputs));
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

  const generateDtmfReply = new Debounced(async () => {
    dtmfReplyRunning = true;

    try {
      task.session.interrupt();

      const dtmfStr = formatDtmf(currDtmfInputs);
      logger.debug(`Generating DTMF reply, current inputs: ${dtmfStr}`);

      // if input not fully received (i.e. timeout), fail the task
      if (currDtmfInputs.length !== numDigits) {
        const errorMsg =
          `Digits input not fully received. ` +
          `Expect ${numDigits} digits, got ${currDtmfInputs.length}`;
        if (!task.done) {
          task.complete(new ToolError(errorMsg));
        }
        return;
      }

      // if not asking for confirmation, return the DTMF inputs
      if (!askForConfirmation) {
        if (!task.done) {
          task.complete(dtmfResultFromInputs(currDtmfInputs));
        }
        return;
      }

      const replyInstructions =
        'User has entered the following valid digits on the telephone keypad:\n' +
        `<dtmf_inputs>${dtmfStr}</dtmf_inputs>\n` +
        'Please confirm it with the user by saying the digits one by one with space in between ' +
        "(.e.g. 'one two three four five six seven eight nine ten'). " +
        'Once you are sure, call `confirm_inputs` with the inputs.';

      await task.session.generateReply({ userInput: replyInstructions });
    } finally {
      dtmfReplyRunning = false;
      currDtmfInputs.length = 0;
    }
  }, dtmfInputTimeout);

  const onSipDtmfReceived = (_code: number, digit: string): void => {
    if (dtmfReplyRunning) {
      return;
    }

    // immediately kick off the DTMF reply generation if matches the stop event
    if (digit === dtmfStopEvent) {
      generateDtmfReply.run();
      return;
    }

    if (!(Object.values(DtmfEvent) as string[]).includes(digit)) {
      logger.warn(`Ignoring invalid DTMF digit: ${digit}`);
      return;
    }

    currDtmfInputs.push(digit as DtmfEvent);
    logger.info(`DTMF inputs: ${formatDtmf(currDtmfInputs)}`);
    generateDtmfReply.schedule();
  };

  const onUserStateChanged = (ev: UserStateChangedEvent): void => {
    if (dtmfReplyRunning) {
      return;
    }

    if (ev.newState === 'speaking') {
      // clear any pending DTMF reply generation
      generateDtmfReply.cancel();
    } else if (currDtmfInputs.length !== 0) {
      // resume any previously cancelled DTMF reply generation after user is back to non-speaking
      generateDtmfReply.schedule();
    }
  };

  const onAgentStateChanged = (ev: AgentStateChangedEvent): void => {
    if (dtmfReplyRunning) {
      return;
    }

    if (ev.newState === 'speaking' || ev.newState === 'thinking') {
      // clear any pending DTMF reply generation
      generateDtmfReply.cancel();
    } else if (currDtmfInputs.length !== 0) {
      // resume any previously cancelled DTMF reply generation after agent is back to non-speaking
      generateDtmfReply.schedule();
    }
  };

  const task = AgentTask.create<GetDtmfResult>({
    id: 'get_dtmf_task',
    instructions,
    chatCtx,
    tools: askForConfirmation ? [confirmInputsTool] : [recordInputsTool],
    onEnter: async () => {
      const ctx = getJobContext();

      ctx.room.on(RoomEvent.DtmfReceived, onSipDtmfReceived);
      task.session.on(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
      task.session.on(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
      task.session.generateReply({ toolChoice: 'none' });
    },
    onExit: async () => {
      const ctx = getJobContext();

      ctx.room.off(RoomEvent.DtmfReceived, onSipDtmfReceived);
      task.session.off(AgentSessionEventTypes.UserStateChanged, onUserStateChanged);
      task.session.off(AgentSessionEventTypes.AgentStateChanged, onAgentStateChanged);
      generateDtmfReply.cancel();
    },
  });

  return task;
}

/**
 * Class wrapper around {@link createGetDtmfTask}, preserving the
 * `new GetDtmfTask(options).run()` API. It composes the functional task and
 * delegates `run()` to it.
 */
export class GetDtmfTask extends AgentTask<GetDtmfResult> {
  readonly #task: AgentTask<GetDtmfResult>;

  constructor(options: GetDtmfTaskOptions) {
    // The wrapper itself never runs as an agent; run() delegates to the
    // composed task. Instructions are resolved inside createGetDtmfTask.
    super({ instructions: '' });
    this.#task = createGetDtmfTask(options);
  }

  override run(): Promise<GetDtmfResult> {
    return this.#task.run();
  }
}
