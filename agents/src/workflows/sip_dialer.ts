// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { SipClient } from 'livekit-server-sdk';
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
    await sip.createSipParticipant(
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
  };
}
