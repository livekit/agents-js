// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentTask } from '../voice/agent.js';
import { createTwilioRecipientDialer } from './twilio_dialer.js';
import {
  type WarmTransferOptions,
  type WarmTransferResult,
  createTransferTask,
} from './warm_transfer.js';

/**
 * Options for `createTwilioConnectorWarmTransferTask`: shared consultation options
 * and Twilio credentials for dialing the recipient.
 * @public
 */
export interface TwilioConnectorWarmTransferTaskOptions extends WarmTransferOptions {
  /** Phone number of the recipient to dial, in E.164 format. */
  phoneNumber: string;
  /**
   * Business Twilio number or verified caller ID. Used without a token and
   * for the caller-ID rejection fallback.
   */
  twilioFromNumber: string;
  /** Twilio account SID. Falls back to the `TWILIO_ACCOUNT_SID` environment variable. */
  twilioAccountSid?: string;
  /** Twilio auth token. Falls back to the `TWILIO_AUTH_TOKEN` environment variable. */
  twilioAuthToken?: string;
  /**
   * `CallToken` from the validated incoming Twilio voice webhook, authorizing reuse
   * of that call's caller ID. Requires the same call's `From` as `originalCallerNumber`.
   * HTTP 400 / Twilio error 21210 or 21212 retries once from `twilioFromNumber` without a token.
   * Other failures are not retried, to avoid duplicate calls.
   * Retrieve the token from server-side state for that specific call; keep it out
   * of prompts and participant attributes. When omitted or empty, use the business caller ID.
   */
  twilioCallToken?: string;
  /** Incoming call’s `From`; used only with a nonempty `twilioCallToken`. */
  originalCallerNumber?: string;
  /**
   * How long to wait for recipient audio after call creation, in milliseconds,
   * before giving up and cancelling the call. Defaults to 30 seconds: Twilio reports
   * no-answer only via status webhooks, which this task does not consume, so
   * the wait is capped instead. `null` disables the local cap and uses Twilio's default.
   * Twilio receives this value rounded up to seconds and clamped to 5–600 seconds.
   * Its provider timeout can include an additional five-second buffer.
   */
  ringingTimeout?: number | null;
}

/**
 * Dial a recipient through the LiveKit Twilio connector, brief them privately,
 * and merge them into the caller room after confirmation.
 * The recipient's published audio signals answer. Cancellation starts bounded,
 * best-effort cleanup of calls whose SID was received; answered calls follow the
 * shared room lifecycle. If Twilio accepts a call but its creation response is
 * lost or lacks a SID, the task cannot target that call for cleanup. It reports
 * failure without retrying, and the call can ring until Twilio's timeout or be
 * answered in the meantime. Cleanup also requires the worker to remain alive.
 * @public
 */
export function createTwilioConnectorWarmTransferTask(
  options: TwilioConnectorWarmTransferTaskOptions,
): AgentTask<WarmTransferResult> {
  const dialRecipient = createTwilioRecipientDialer(options);
  return createTransferTask(options, 'human-agent-connector', dialRecipient);
}

/**
 * Class wrapper around `createTwilioConnectorWarmTransferTask`,
 * matching the `new WarmTransferTask(options).run()` API.
 * @public
 */
export class TwilioConnectorWarmTransferTask extends AgentTask<WarmTransferResult> {
  readonly #task: AgentTask<WarmTransferResult>;

  constructor(options: TwilioConnectorWarmTransferTaskOptions) {
    super({ instructions: '' });
    this.#task = createTwilioConnectorWarmTransferTask(options);
  }

  override run(): Promise<WarmTransferResult> {
    return this.#task.run();
  }
}
