---
'@livekit/agents': patch
---

Add optional `originalCallerNumber` and `twilioCallToken` to `TwilioConnectorWarmTransferTask` to preserve the inbound caller ID on Twilio warm transfers, with fallback to the business number.
