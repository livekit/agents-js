// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, log } from '@livekit/agents';
import type { RemoteParticipant } from '@livekit/rtc-node';
import { SipClient } from 'livekit-server-sdk';

const logger = log().child({ example: 'homepage-frontdesk-phone' });

export const PHONE = 'phone';
export const CALL_ERROR_ATTRIBUTE = 'call.error';

export function outboundLine(metadata: Record<string, unknown>): [string, string] {
  return [
    typeof metadata.trunk === 'string' ? metadata.trunk : '',
    typeof metadata.from === 'string' ? metadata.from : '',
  ];
}

export async function dialPhone(
  ctx: JobContext,
  number: string,
  trunk: string,
  fromNumber: string,
): Promise<RemoteParticipant | null> {
  try {
    const roomName = ctx.room.name;
    if (!roomName) throw new Error('cannot dial without a room name');
    const sip = new SipClient(ctx.info.url, ctx.info.apiKey ?? '', ctx.info.apiSecret ?? '');
    await sip.createSipParticipant(trunk, number, roomName, {
      participantIdentity: PHONE,
      fromNumber,
      waitUntilAnswered: true,
    });
  } catch (error) {
    logger.warn({ error }, 'outbound call failed');
    await ctx.room.localParticipant!.setAttributes({
      [CALL_ERROR_ATTRIBUTE]: dialError(error),
    });
    return null;
  }
  return ctx.waitForParticipant(PHONE);
}

export function dialError(error: unknown): string {
  const record = isRecord(error) ? error : {};
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const status = String(metadata.sip_status_code ?? metadata.sipStatusCode ?? '');
  if (['408', '480', '487'].includes(status)) return "The phone didn't answer.";
  if (['486', '600'].includes(status)) return 'The line was busy.';
  if (status === '603') return 'The call was declined.';
  const message = typeof record.message === 'string' ? record.message : String(error);
  const detail = status
    ? `SIP ${status}: ${String(metadata.sip_status ?? metadata.sipStatus ?? '')}`
    : message;
  return `The call couldn't be placed (${detail}).`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
