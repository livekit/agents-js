// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Connect Twilio phone calls to a LiveKit agent with the Twilio connector.
 *
 * The connector uses Twilio Media Streams instead of a SIP trunk. Your webhook
 * answers Twilio's request with TwiML that points at a LiveKit WebSocket URL,
 * and the call joins a LiveKit room as a regular participant.
 *
 * This example reuses the support agent from ../warm_transfer.ts. Run that
 * agent in another terminal, then run this server. See README.md for setup.
 *
 * Docs: https://docs.livekit.io/telephony/connectors/twilio/
 */
import {
  ConnectTwilioCallRequest_TwilioCallDirection,
  ConnectorClient,
  RoomAgentDispatch,
  TwirpError,
} from 'livekit-server-sdk';
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { parseArgs } from 'node:util';

// Must match the dispatch name the agent registered with.
const AGENT_NAME = process.env.AGENT_DISPATCH_NAME ?? 'warm-transfer';
const PORT = Number(process.env.PORT ?? 8080);

// Twilio credentials are needed for the `dial` command. When the auth token is
// set, inbound webhook signatures are verified with it too.
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER ?? '';
// The exact public URL configured in the Twilio console. Twilio signs this
// URL, so signature verification needs it verbatim.
const TWILIO_WEBHOOK_URL = process.env.TWILIO_WEBHOOK_URL ?? '';

// The API key and secret are read from LIVEKIT_API_KEY and LIVEKIT_API_SECRET.
if (!process.env.LIVEKIT_URL) throw new Error('LIVEKIT_URL must be set');
const connector = new ConnectorClient(process.env.LIVEKIT_URL);

const twiml = (connectUrl: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${connectUrl}" />
    </Connect>
</Response>`;

const FAILURE_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>We are unable to connect your call right now. Please try again later.</Say>
</Response>`;

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
 * Check the X-Twilio-Signature header: HMAC-SHA1 over the public URL followed
 * by the sorted form parameters, keyed with the auth token.
 */
function twilioSignatureValid(form: URLSearchParams, header: string): boolean {
  const payload =
    TWILIO_WEBHOOK_URL +
    [...form.keys()]
      .sort()
      .map((key) => key + (form.get(key) ?? ''))
      .join('');
  const expected = createHmac('sha1', TWILIO_AUTH_TOKEN).update(payload).digest('base64');
  return timingSafeEqualStrings(expected, header);
}

/**
 * Answer Twilio's inbound call webhook with TwiML that bridges the call
 * into a LiveKit room and dispatches the agent.
 */
async function handleVoiceWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  verify: boolean,
): Promise<void> {
  let body = '';
  for await (const chunk of req) body += chunk;
  const form = new URLSearchParams(body);

  if (verify && !twilioSignatureValid(form, String(req.headers['x-twilio-signature'] ?? ''))) {
    console.warn('Rejected webhook with a bad signature');
    res.writeHead(403).end();
    return;
  }

  const callSid = form.get('CallSid') ?? '';
  const caller = form.get('From') ?? '';
  console.log(`Inbound call ${callSid} from ${mask(caller)}`);

  let connectUrl: string;
  try {
    const result = await connector.connectTwilioCall({
      twilioCallDirection: ConnectTwilioCallRequest_TwilioCallDirection.INBOUND,
      roomName: `call-${callSid}`,
      participantIdentity: caller,
      participantName: caller,
      agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
    });
    connectUrl = result.connectUrl;
  } catch (e) {
    // Answer with TwiML either way: an HTTP error plays an error tone to the caller.
    if (e instanceof TwirpError) {
      console.error(`Connector rejected call ${callSid}: ${e.code}: ${redactNumbers(e.message)}`);
    } else {
      console.error(`Failed to connect call ${callSid}:`, e);
    }
    res.writeHead(200, { 'Content-Type': 'text/xml' }).end(FAILURE_TWIML);
    return;
  }

  console.log(`Bridging call ${callSid} into room call-${callSid}`);
  res.writeHead(200, { 'Content-Type': 'text/xml' }).end(twiml(connectUrl));
}

function serve(verify: boolean): void {
  http
    .createServer(async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method !== 'POST' || path !== '/twilio/voice') {
        res.writeHead(404).end();
        return;
      }

      try {
        await handleVoiceWebhook(req, res, verify);
      } catch (err) {
        console.error('Failed to handle webhook:', err);
        if (!res.headersSent) res.writeHead(500).end();
      }
    })
    .listen(PORT, () => console.log(`Twilio webhook server listening on port ${PORT}`));
}

/**
 * Place an outbound call through the connector.
 *
 * The flow has two steps. First, connectTwilioCall returns a WebSocket URL
 * and pre-joins the room. The connector participant stays hidden until the
 * callee answers. Second, the Twilio REST API creates the call with the
 * HTTPS form of that URL, which returns the TwiML above when Twilio fetches it.
 */
async function dial(toNumber: string): Promise<void> {
  if (!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER)) {
    console.error('Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER to dial');
    process.exit(1);
  }

  const roomName = `call-out-${Math.floor(Date.now() / 1000)}`;
  let connectUrl: string;
  try {
    const result = await connector.connectTwilioCall({
      twilioCallDirection: ConnectTwilioCallRequest_TwilioCallDirection.OUTBOUND,
      roomName,
      participantIdentity: toNumber,
      agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
    });
    connectUrl = result.connectUrl;
  } catch (e) {
    if (!(e instanceof TwirpError)) throw e;
    console.error(`Connector rejected the call: ${e.code}: ${redactNumbers(e.message)}`);
    process.exit(1);
  }

  // Twilio fetches TwiML over HTTPS from the same single-use URL.
  const twimlUrl = connectUrl.replace('wss://', 'https://');

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: new URLSearchParams({ To: toNumber, From: TWILIO_FROM_NUMBER, Url: twimlUrl }),
    },
  );
  const body = await resp.text();
  if (!resp.ok) {
    console.error(`Twilio call creation failed: ${redactNumbers(body)}`);
    process.exit(1);
  }
  const { sid } = JSON.parse(body) as { sid?: string };
  console.log(`Dialing ${mask(toNumber)}, Twilio call SID ${sid}, room ${roomName}`);
}

function usage(): never {
  console.error('Usage: twilio_connector.ts serve [--allow-unverified]');
  console.error('       twilio_connector.ts dial --to <number, E.164 format>');
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'serve') {
  const { values } = parseArgs({
    args: rest,
    options: { 'allow-unverified': { type: 'boolean' } },
  });
  const allowUnverified = values['allow-unverified'] ?? false;
  const verify = Boolean(TWILIO_AUTH_TOKEN && TWILIO_WEBHOOK_URL) && !allowUnverified;
  if (!verify) {
    if (!allowUnverified) {
      console.error(
        'Set TWILIO_AUTH_TOKEN and TWILIO_WEBHOOK_URL to verify webhook signatures,' +
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
