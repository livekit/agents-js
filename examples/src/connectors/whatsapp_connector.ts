// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Connect WhatsApp Business calls to a LiveKit agent with the WhatsApp connector.
 *
 * Meta delivers call events to a webhook you register with your WhatsApp
 * Business app. This server handles those events: it accepts inbound calls,
 * completes outbound calls, and cleans up when a call ends. The call joins a
 * LiveKit room as a regular participant.
 *
 * This example reuses the support agent from ../warm_transfer.ts. Run that
 * agent in another terminal, then run this server. See README.md for setup.
 *
 * Docs: https://docs.livekit.io/telephony/connectors/whatsapp/
 * Meta docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling
 */
import {
  type AcceptWhatsAppCallResponse,
  ConnectorClient,
  DisconnectWhatsAppCallRequest_DisconnectReason,
  RoomAgentDispatch,
  SessionDescription,
  TwirpError,
} from 'livekit-server-sdk';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { parseArgs } from 'node:util';

// Must match the dispatch name the agent registered with.
const AGENT_NAME = process.env.AGENT_DISPATCH_NAME ?? 'warm-transfer';
const PORT = Number(process.env.PORT ?? 8080);

// From your Meta app: the business phone number ID and an access token.
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY ?? '';
// Must be a version the connector supports. See the LiveKit docs for the list.
const WHATSAPP_CLOUD_API_VERSION = process.env.WHATSAPP_CLOUD_API_VERSION ?? '26.0';
// The token you chose when registering the webhook with Meta.
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? 'livekit-connector-example';
// Your Meta app secret, used to verify webhook signatures.
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? '';

// Twirp error code for a request that duplicates an existing resource.
const TWIRP_ALREADY_EXISTS = 'already_exists';

// The API key and secret are read from LIVEKIT_API_KEY and LIVEKIT_API_SECRET.
if (!process.env.LIVEKIT_URL) throw new Error('LIVEKIT_URL must be set');
const connector = new ConnectorClient(process.env.LIVEKIT_URL);

// The parts of Meta's `calls` webhook payload this example uses.
interface WhatsAppCall {
  id: string;
  event: string;
  direction?: string;
  from?: string;
  session?: { sdp_type: string; sdp: string };
}

interface WebhookValue {
  calls?: WhatsAppCall[];
  errors?: unknown[];
  statuses?: unknown[];
  metadata?: { phone_number_id?: string };
}

interface WebhookBody {
  entry?: { changes?: { field: string; value?: WebhookValue }[] }[];
}

/** Meta verifies the webhook once at registration with a GET challenge. */
function handleVerification(query: URLSearchParams, res: http.ServerResponse): void {
  if (
    query.get('hub.mode') === 'subscribe' &&
    query.get('hub.verify_token') === WHATSAPP_VERIFY_TOKEN
  ) {
    res.writeHead(200).end(query.get('hub.challenge') ?? '');
  } else {
    res.writeHead(403).end();
  }
}

/** Keep phone numbers out of logs, matching the other telephony examples. */
function mask(number: string): string {
  return number.length > 4 ? `...${number.slice(-4)}` : '****';
}

/** Mask phone-number-like digit runs inside provider payloads before logging. */
function redactNumbers(text: string): string {
  return text.replace(/\+?\d{7,15}/g, (match) => mask(match));
}

function timingSafeEqualStrings(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

/**
 * Check the X-Hub-Signature-256 header: HMAC-SHA256 over the raw request
 * body, keyed with the Meta app secret.
 */
function signatureValid(raw: Buffer, header: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', WHATSAPP_APP_SECRET).update(raw).digest('hex');
  return timingSafeEqualStrings(expected, header);
}

/**
 * Accept an inbound call and dispatch the agent. Returns null when the call
 * was a webhook redelivery or the accept failed.
 */
async function acceptCall(
  call: WhatsAppCall,
  callId: string,
  phoneNumberId: string,
): Promise<AcceptWhatsAppCallResponse | null> {
  try {
    return await connector.acceptWhatsAppCall({
      whatsappPhoneNumberId: phoneNumberId,
      whatsappApiKey: WHATSAPP_API_KEY,
      whatsappCloudApiVersion: WHATSAPP_CLOUD_API_VERSION,
      whatsappCallId: callId,
      sdp: new SessionDescription({ type: call.session!.sdp_type, sdp: call.session!.sdp }),
      roomName: `whatsapp-${callId}`,
      // The identity ends up in logs, so keep the phone number out of it.
      // The name field is redacted and can carry it.
      participantIdentity: `wa-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      participantName: call.from ?? '',
      agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
      waitUntilAnswered: true,
    });
  } catch (e) {
    if (!(e instanceof TwirpError)) throw e;
    if (e.code === TWIRP_ALREADY_EXISTS) {
      // Meta redelivers webhooks, so a second accept for the same call is expected.
      console.log(`Call ${callId} was already accepted`);
    } else {
      console.error(`Failed to accept call ${callId}: ${e.code}: ${redactNumbers(e.message)}`);
    }
    return null;
  }
}

/** Route one entry of the webhook's `calls` array to the connector API. */
async function handleCallEvent(call: WhatsAppCall, phoneNumberId: string): Promise<void> {
  const { id: callId, event, direction } = call;
  console.log(`Call event ${event} (${direction}) for ${callId}`);

  if (event === 'connect' && direction === 'USER_INITIATED') {
    // An inbound call. Accept it right away: the caller's phone is already
    // ringing, and WhatsApp drops the call if media takes too long to start.
    // waitUntilAnswered makes this request block until the agent is in the
    // room, so a failure to answer surfaces here as an error.
    const res = await acceptCall(call, callId, phoneNumberId);
    if (res !== null) {
      console.log(`Accepted call ${callId} into room ${res.roomName}`);
    }
  } else if (event === 'connect' && direction === 'BUSINESS_INITIATED') {
    // The callee answered an outbound call placed with `dial`. The webhook
    // carries their SDP answer; pass it on to complete the connection.
    // (livekit-server-sdk does not expose waitUntilAnswered here yet, so a
    // media failure surfaces as silence on the call instead of an error.)
    try {
      await connector.connectWhatsAppCall(
        callId,
        new SessionDescription({ type: call.session!.sdp_type, sdp: call.session!.sdp }),
      );
      console.log(`Connected outbound call ${callId}`);
    } catch (e) {
      if (!(e instanceof TwirpError)) throw e;
      if (e.code === TWIRP_ALREADY_EXISTS) {
        // Meta redelivers webhooks, so a second connect for the same call is expected.
        console.log(`Call ${callId} was already connected`);
      } else {
        console.error(`Failed to connect call ${callId}: ${e.code}: ${redactNumbers(e.message)}`);
      }
    }
  } else if (event === 'terminate') {
    // Tell LiveKit to clean up the connector session and the room.
    // Meta also sends this event when the business ended the call, and the
    // session is already gone in that case, so an error here is expected.
    try {
      await connector.disconnectWhatsAppCall(
        callId,
        WHATSAPP_API_KEY,
        DisconnectWhatsAppCallRequest_DisconnectReason.USER_INITIATED,
      );
      console.log(`Disconnected call ${callId}`);
    } catch (e) {
      if (!(e instanceof TwirpError)) throw e;
      console.log(`Call ${callId} was already cleaned up: ${e.code}`);
    }
  } else {
    console.warn(`Unhandled call event ${event} for ${callId}`);
  }
}

/** Await a webhook-triggered task and log any unexpected failure. */
async function runLogged(promise: Promise<void>, description: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    console.error(`Failed to handle ${description}:`, err);
  }
}

/** Meta requires a fast 200, so call handling runs in the background. */
function handleWebhook(raw: Buffer, tasks: Set<Promise<void>>): void {
  let webhook: WebhookBody;
  try {
    webhook = JSON.parse(raw.toString()) as WebhookBody;
  } catch {
    // Respond 200 anyway. An error response makes Meta redeliver the same payload.
    console.warn(
      `Ignoring unparseable webhook body: ${redactNumbers(raw.toString().slice(0, 200))}`,
    );
    return;
  }

  for (const entry of webhook.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'calls') continue;
      const value = change.value ?? {};
      for (const error of value.errors ?? []) {
        console.warn(`WhatsApp reported an error: ${redactNumbers(JSON.stringify(error))}`);
      }
      for (const status of value.statuses ?? []) {
        console.log(`Status update: ${redactNumbers(JSON.stringify(status))}`);
      }
      // Prefer the number ID the event arrived on; multi-number apps get several.
      const phoneNumberId = value.metadata?.phone_number_id || WHATSAPP_PHONE_NUMBER_ID;
      for (const call of value.calls ?? []) {
        const task = runLogged(handleCallEvent(call, phoneNumberId), `call event ${call.id}`);
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      }
    }
  }
}

function serve(verify: boolean): void {
  const tasks = new Set<Promise<void>>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/whatsapp/webhook') {
      handleVerification(url.searchParams, res);
    } else if (req.method === 'POST' && url.pathname === '/whatsapp/webhook') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);

      if (verify && !signatureValid(raw, String(req.headers['x-hub-signature-256'] ?? ''))) {
        console.warn('Rejected webhook with a bad signature');
        res.writeHead(403).end();
        return;
      }

      try {
        handleWebhook(raw, tasks);
        res.writeHead(200).end('ok');
      } catch (err) {
        console.error('Failed to handle webhook:', err);
        res.writeHead(500).end();
      }
    } else {
      res.writeHead(404).end();
    }
  });

  // The server stops accepting requests, then in-flight call handling
  // finishes before the process exits. The connector client is fetch-based,
  // so there is nothing else to close.
  const shutdown = async (): Promise<void> => {
    server.close();
    await Promise.allSettled(tasks);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  server.listen(PORT, () => console.log(`WhatsApp webhook server listening on port ${PORT}`));
}

/**
 * Place an outbound call. Keep the webhook server running: Meta sends the
 * SDP answer there, and the server completes the connection.
 *
 * Outbound calling requires user permission and is not available in every
 * country. See the Meta docs linked above.
 */
async function dial(toNumber: string): Promise<void> {
  if (!(WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_API_KEY)) {
    console.error('Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_API_KEY to dial');
    process.exit(1);
  }

  let res;
  try {
    res = await connector.dialWhatsAppCall({
      whatsappPhoneNumberId: WHATSAPP_PHONE_NUMBER_ID,
      whatsappToPhoneNumber: toNumber,
      whatsappApiKey: WHATSAPP_API_KEY,
      whatsappCloudApiVersion: WHATSAPP_CLOUD_API_VERSION,
      agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
    });
  } catch (e) {
    if (!(e instanceof TwirpError)) throw e;
    // Meta rejections ride along in the message, including the fbtrace_id.
    console.error(`Dial failed: ${e.code}: ${redactNumbers(e.message)}`);
    process.exit(1);
  }
  console.log(`Dialing ${mask(toNumber)}: call ${res.whatsappCallId}, room ${res.roomName}`);
}

function usage(): never {
  console.error('Usage: whatsapp_connector.ts serve [--allow-unverified]');
  console.error('       whatsapp_connector.ts dial --to <number, country code, no plus sign>');
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'serve') {
  const { values } = parseArgs({
    args: rest,
    options: { 'allow-unverified': { type: 'boolean' } },
  });
  const allowUnverified = values['allow-unverified'] ?? false;
  if (!(WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_API_KEY)) {
    console.warn(
      'WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_API_KEY is not set; accepting calls will fail',
    );
  }
  const verify = Boolean(WHATSAPP_APP_SECRET) && !allowUnverified;
  if (!verify) {
    if (!allowUnverified) {
      console.error(
        'Set WHATSAPP_APP_SECRET to verify webhook signatures,' +
          ' or pass --allow-unverified for local testing',
      );
      process.exit(1);
    }
    console.warn('Webhook signature verification is disabled');
  }
  serve(verify);
} else if (command === 'dial') {
  const { values } = parseArgs({ args: rest, options: { to: { type: 'string' } } });
  if (!values.to) usage();
  await dial(values.to);
} else {
  usage();
}
