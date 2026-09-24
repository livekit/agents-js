// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { RoomServiceClient, SipClient } from 'livekit-server-sdk';
import { log } from '../log.js';
import type { DialRecipient, WarmTransferTaskOptions } from './warm_transfer.js';

/** Validate SIP configuration before the transfer starts. @internal */
export function createSipRecipientDialer({
  sipCallTo,
  sipTrunkId: rawSipTrunkId,
  sipConnection,
  sipNumber = process.env.LIVEKIT_SIP_NUMBER ?? '',
  sipHeaders = {},
  dtmf,
  ringingTimeout,
}: Pick<
  WarmTransferTaskOptions,
  | 'sipCallTo'
  | 'sipTrunkId'
  | 'sipConnection'
  | 'sipNumber'
  | 'sipHeaders'
  | 'dtmf'
  | 'ringingTimeout'
>): DialRecipient {
  if (!sipCallTo) {
    throw new Error('`sipCallTo` must be set');
  }

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

  return async ({ roomName, recipientIdentity, connection, signal }) => {
    signal.throwIfAborted();
    const sip = new SipClient(connection.url);
    const participant = await sip.createSipParticipant(
      sipTrunkId ?? '',
      sipCallTo,
      roomName,
      {
        participantIdentity: recipientIdentity,
        waitUntilAnswered: true,
        fromNumber: sipNumber || undefined,
        headers: sipHeaders,
        dtmf: dtmf ?? undefined,
        // SIP requires whole seconds.
        ringingTimeout: ringingTimeout != null ? Math.round(ringingTimeout / 1000) : undefined,
      },
      sipConnection,
    );
    if (signal.aborted) {
      // The workflow can finish before the non-cancellable SIP request returns.
      const rooms = new RoomServiceClient(connection.url, connection.apiKey, connection.apiSecret, {
        requestTimeout: 10,
      });
      try {
        await rooms.removeParticipant(participant.roomName, participant.participantIdentity);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'not_found')) {
          log().warn({ error }, 'failed to remove SIP participant created after cancellation');
        }
      }
      signal.throwIfAborted();
    }
  };
}
