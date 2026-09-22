// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Room } from '@livekit/rtc-node';
import {
  type RemoteParticipant,
  type RemoteTrackPublication,
  RoomEvent,
  TrackKind,
} from '@livekit/rtc-node';
import { ConnectTwilioCallRequest_TwilioCallDirection, ConnectorClient } from 'livekit-server-sdk';
import { ToolError } from '../llm/index.js';
import { log } from '../log.js';
import { Future, waitUntilAborted } from '../utils.js';
import type { TwilioConnectorWarmTransferTaskOptions } from './twilio_connector_warm_transfer.js';
import type { DialRecipient } from './warm_transfer.js';

/** Validate Twilio configuration before the transfer starts. @internal */
export function createTwilioRecipientDialer(
  options: TwilioConnectorWarmTransferTaskOptions,
): DialRecipient {
  const {
    phoneNumber,
    twilioFromNumber,
    twilioAccountSid = process.env.TWILIO_ACCOUNT_SID ?? '',
    twilioAuthToken = process.env.TWILIO_AUTH_TOKEN ?? '',
    twilioCallToken,
    originalCallerNumber,
    ringingTimeout = 30_000,
  } = options;

  if (!twilioAccountSid || !twilioAuthToken) {
    throw new Error(
      'Twilio credentials are required: pass `twilioAccountSid` and `twilioAuthToken` or set' +
        ' the TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables',
    );
  }
  if (twilioCallToken && !originalCallerNumber) {
    throw new Error('twilioCallToken requires originalCallerNumber');
  }
  const auth = { accountSid: twilioAccountSid, authToken: twilioAuthToken };

  if (
    ringingTimeout != null &&
    (!Number.isSafeInteger(ringingTimeout) || ringingTimeout < 0 || ringingTimeout > 2_147_483_647)
  ) {
    throw new Error('ringingTimeout must be null or a nonnegative 32-bit integer');
  }

  return async ({ roomName, recipientIdentity, room, connection, signal }) => {
    signal.throwIfAborted();
    const connector = new ConnectorClient(connection.url, connection.apiKey, connection.apiSecret);
    const { connectUrl } = await connector.connectTwilioCall({
      twilioCallDirection: ConnectTwilioCallRequest_TwilioCallDirection.OUTBOUND,
      roomName,
      participantIdentity: recipientIdentity,
    });

    const twiml = `<Response><Connect><Stream url=${escapeXmlAttribute(connectUrl)}/></Connect></Response>`;
    let callSid: string;
    signal.throwIfAborted();
    try {
      callSid = await createTwilioCall(auth, {
        to: phoneNumber,
        from: twilioCallToken ? originalCallerNumber! : twilioFromNumber,
        twiml,
        callToken: twilioCallToken || undefined,
        ringingTimeout,
      });
    } catch (error) {
      // Retry only a definitive caller-ID rejection before a call was created.
      // 21210 = From not verified (token rejected/expired), 21212 = invalid From
      // (e.g. withheld/anonymous inbound caller).
      if (
        !twilioCallToken ||
        signal.aborted ||
        !(error instanceof TwilioCallCreationError) ||
        error.status !== 400 ||
        (error.code !== 21210 && error.code !== 21212)
      ) {
        throw error;
      }
      callSid = await createTwilioCall(auth, {
        to: phoneNumber,
        from: twilioFromNumber,
        twiml,
        ringingTimeout,
      });
    }

    try {
      signal.throwIfAborted();
      await waitForConnectorAnswer({ room, identity: recipientIdentity, ringingTimeout, signal });
      signal.throwIfAborted();
    } catch (error) {
      // Cleanup owns its deadline and must not delay resuming the caller.
      void cancelTwilioCall(auth, callSid);
      throw error;
    }
  };
}

/**
 * The connector publishes the recipient's audio track only after the call is
 * answered, so treat that publication as the answer signal.
 */
async function waitForConnectorAnswer(options: {
  room: Room;
  identity: string;
  ringingTimeout: number | null;
  signal: AbortSignal;
}): Promise<void> {
  const { room, identity, ringingTimeout, signal } = options;
  const answered = new Future<void>();

  const hasPublishedAudio = (participant: RemoteParticipant): boolean =>
    participant.identity === identity &&
    [...participant.trackPublications.values()].some((pub) => pub.kind === TrackKind.KIND_AUDIO);

  const resolveIfAnswered = (participant: RemoteParticipant): void => {
    if (hasPublishedAudio(participant) && !answered.done) {
      answered.resolve();
    }
  };
  const onTrackPublished = (_: RemoteTrackPublication, participant: RemoteParticipant): void =>
    resolveIfAnswered(participant);

  room.on(RoomEvent.TrackPublished, onTrackPublished);
  room.on(RoomEvent.ParticipantConnected, resolveIfAnswered);
  try {
    // Checked after the listeners are attached, so a connector that joined and
    // published before this wait started isn't missed.
    const existing = room.remoteParticipants.get(identity);
    if (existing) {
      resolveIfAnswered(existing);
    }

    const waitSignal =
      ringingTimeout != null
        ? AbortSignal.any([signal, AbortSignal.timeout(ringingTimeout)])
        : signal;
    const result = await waitUntilAborted(answered.await, waitSignal);
    if (result.isAborted) {
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      throw new ToolError('recipient did not answer');
    }
  } finally {
    room.off(RoomEvent.TrackPublished, onTrackPublished);
    room.off(RoomEvent.ParticipantConnected, resolveIfAnswered);
  }
}

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

interface TwilioRestAuth {
  accountSid: string;
  authToken: string;
}

const twilioRequest = (
  auth: TwilioRestAuth,
  path: string,
  form: Record<string, string>,
  signal?: AbortSignal,
) =>
  fetch(`${TWILIO_API_BASE}/Accounts/${encodeURIComponent(auth.accountSid)}${path}`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Basic ${Buffer.from(`${auth.accountSid}:${auth.authToken}`).toString('base64')}`,
    },
    body: new URLSearchParams(form),
  });

class TwilioCallCreationError extends Error {
  constructor(
    readonly status: number,
    readonly code?: number,
  ) {
    // Do not include the response body: it can contain caller data or a token.
    super(`Twilio call creation failed (${status}, code ${code ?? 'unknown'})`);
  }
}

/** Place the recipient call with the Twilio REST API; returns the call SID. */
async function createTwilioCall(
  auth: TwilioRestAuth,
  options: {
    to: string;
    from: string;
    twiml: string;
    callToken?: string;
    ringingTimeout: number | null;
  },
): Promise<string> {
  let resp: Response;
  let body: string;
  try {
    resp = await twilioRequest(auth, '/Calls.json', {
      To: options.to,
      From: options.from,
      Twiml: options.twiml,
      ...(options.ringingTimeout != null
        ? { Timeout: String(Math.min(600, Math.max(5, Math.ceil(options.ringingTimeout / 1000)))) }
        : {}),
      ...(options.callToken !== undefined ? { CallToken: options.callToken } : {}),
    });
    body = await resp.text();
  } catch {
    // Transport errors can retain request data, including CallToken.
    throw new Error('Twilio call creation request failed');
  }
  if (!resp.ok) {
    let code: number | undefined;
    try {
      const parsed = JSON.parse(body) as { code?: unknown };
      if (typeof parsed?.code === 'number') code = parsed.code;
    } catch {
      // Unparseable errors are never eligible for the caller-ID fallback.
    }
    throw new TwilioCallCreationError(resp.status, code);
  }
  let sid: unknown;
  try {
    sid = (JSON.parse(body) as { sid?: unknown }).sid;
  } catch {
    throw new Error('Twilio call creation returned an invalid response');
  }
  if (typeof sid !== 'string' || !sid) {
    throw new Error('Twilio call creation returned no call SID');
  }
  return sid;
}

/** End a pending call, including one that answered during cancellation. */
async function cancelTwilioCall(auth: TwilioRestAuth, callSid: string): Promise<void> {
  let resp: Response;
  try {
    resp = await twilioRequest(
      auth,
      `/Calls/${encodeURIComponent(callSid)}.json`,
      {
        Status: 'completed',
      },
      AbortSignal.timeout(10_000),
    );
  } catch {
    // Keep transport error messages out of logs: they can contain request data.
    log().warn('failed to cancel Twilio call: request failed');
    return;
  }
  if (!resp.ok) {
    // Preserve the original dial failure and report only the HTTP status.
    log().warn({ status: resp.status }, 'failed to cancel Twilio call');
  }
}

/** XML-escape a value and wrap it in double quotes for use as an attribute. */
function escapeXmlAttribute(value: string): string {
  const escaped = value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `"${escaped}"`;
}
