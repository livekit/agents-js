// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { setTimeout as waitFor } from 'node:timers/promises';
import { z } from 'zod';
import { getJobContext } from '../../job.js';
import { ToolError, ToolResult, tool } from '../../llm/index.js';

const DEFAULT_DTMF_PUBLISH_DELAY = 300;

const DTMF_EVENTS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '0',
  '*',
  '#',
  'A',
  'B',
  'C',
  'D',
] as const;

export type DtmfEvent = (typeof DTMF_EVENTS)[number];

function dtmfEventToCode(event: DtmfEvent): number {
  if (/^\d$/.test(event)) {
    return Number(event);
  }
  if (event === '*') {
    return 10;
  }
  if (event === '#') {
    return 11;
  }

  return event.charCodeAt(0) - 'A'.charCodeAt(0) + 12;
}

export const sendDtmfEvents = tool({
  name: 'send_dtmf_events',
  description: `
Send a list of DTMF events to the telephony provider.
Successful sends do not request a follow-up reply.

Call when:
- User wants to send DTMF events
`,
  parameters: z.object({
    events: z.array(z.enum(DTMF_EVENTS)).describe('The DTMF events to send.'),
  }),
  execute: async ({ events }, { ctx, abortSignal }) => {
    const room = ctx.session._roomIO?.rtcRoom ?? getJobContext().room;

    for (const event of events) {
      try {
        const code = dtmfEventToCode(event);
        if (!room.localParticipant) {
          throw new Error('room local participant is not available');
        }

        await room.localParticipant.publishDtmf(code, event);
        await waitFor(DEFAULT_DTMF_PUBLISH_DELAY, undefined, { signal: abortSignal });
      } catch (error) {
        // a cancelled call propagates; a failed publish hides the provider error from the model
        if (error instanceof Error && error.name === 'AbortError') {
          throw error;
        }
        throw new ToolError('Failed to send DTMF events.');
      }
    }

    return new ToolResult(`Successfully sent DTMF events: ${events.join(', ')}`, {
      replyRequired: false,
    });
  },
});
