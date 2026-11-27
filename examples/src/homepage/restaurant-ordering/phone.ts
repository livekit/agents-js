// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, log } from '@livekit/agents';
import type { RemoteParticipant } from '@livekit/rtc-node';
import { SipClient } from 'livekit-server-sdk';

const logger = log().child({ example: 'restaurant-ordering-phone' });
export const PHONE = 'phone';
export const CALL_ERROR_ATTRIBUTE = 'call.error';
export function outboundLine(meta: Record<string, unknown>): [string, string] {
  return [
    typeof meta.trunk === 'string' ? meta.trunk : '',
    typeof meta.from === 'string' ? meta.from : '',
  ];
}
export async function dialPhone(
  ctx: JobContext,
  number: string,
  trunk: string,
  from: string,
): Promise<RemoteParticipant | null> {
  try {
    const sip = new SipClient(ctx.info.url, ctx.info.apiKey ?? '', ctx.info.apiSecret ?? '');
    await sip.createSipParticipant(trunk, number, ctx.room.name!, {
      participantIdentity: PHONE,
      fromNumber: from,
      waitUntilAnswered: true,
    });
  } catch (error) {
    logger.warn({ error }, 'outbound call failed');
    await ctx.room.localParticipant!.setAttributes({ [CALL_ERROR_ATTRIBUTE]: dialError(error) });
    return null;
  }
  return await ctx.waitForParticipant(PHONE);
}
export function dialError(error: unknown): string {
  const value = error as { message?: string; metadata?: Record<string, string> },
    metadata = value.metadata ?? {},
    status = metadata.sip_status_code ?? '';
  if (['408', '480', '487'].includes(status)) return "The phone didn't answer.";
  if (['486', '600'].includes(status)) return 'The line was busy.';
  if (status === '603') return 'The call was declined.';
  const detail = status
    ? `SIP ${status}: ${metadata.sip_status ?? ''}`
    : value.message ?? String(error);
  return `The call couldn't be placed (${detail}).`;
}
