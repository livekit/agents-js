<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Preserve the inbound caller's number with Telnyx

The [warm-transfer example](warm_transfer.ts) creates a new outbound call to a
supervisor. To let the supervisor identify the customer, an application can
preserve the customer's caller ID instead of presenting its business number.
The existing `sipNumber` and `sipHeaders` options support this with a Telnyx SIP
trunk.

For an inbound call from customer A to your Telnyx number B, followed by a
transfer to supervisor C, [Telnyx requires](https://support.telnyx.com/en/articles/13117410-how-external-call-transfers-work):

- The original A-to-B call must still be active when dialing C.
- The outbound call must present A as the caller and include a SIP `Diversion`
  header identifying B.

In the example's `transfer_to_human` tool, use the following options when
creating the task. `inboundCustomerNumber` and `inboundTelnyxNumber` are
application variables: retrieve the original caller and called number from
trusted, server-side context for this specific inbound call. Normalize both to
E.164 before constructing the header. `SIP_TRUNK_ID` must select your configured
Telnyx outbound trunk.

```typescript
const result = await new workflows.WarmTransferTask({
  sipCallTo: SUPERVISOR_PHONE_NUMBER,
  sipTrunkId: SIP_TRUNK_ID,
  sipNumber: inboundCustomerNumber,
  sipHeaders: {
    Diversion: `<sip:${inboundTelnyxNumber}@sip.telnyx.com>;reason=unconditional`,
  },
  chatCtx: ctx.session.history,
  instructions: { extra: SUMMARY_INSTRUCTIONS },
  greetingSpeech: (session) => session.generateReply({ toolChoice: 'none' }),
  callerHangupSpeech: 'The caller has disconnected. I am ending this call now.',
}).run();
```

This uses the existing SIP warm-transfer flow; it does not require a CallToken
or a Telnyx-specific SDK flag. Keep the customer's original call connected
during consultation. Applications that want their business caller ID can keep
the existing example configuration.

## Verify and troubleshoot

Call B from phone A, request a transfer to phone C, then check the number shown
on C and complete the consultation and transfer. Caller-ID presentation also
depends on the receiving network. This snippet illustrates configuration; it
does not by itself verify carrier acceptance.

For `403 Unverified origination number D51`, check that the A-to-B call is still
active, the outbound caller number matches A, and `Diversion` identifies the
actual Telnyx number B that received the call. Inspect the outbound SIP INVITE
to confirm that the header reaches Telnyx. An arbitrary customer number or a
header copied from a different call does not establish a valid transfer.
