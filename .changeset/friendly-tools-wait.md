---
'@livekit/agents-plugin-phonic': patch
---

Wait for Phonic speech to start before creating a post-tool generation, so agent
handoffs do not wait for an empty queued response. Automatic tool replies still
start on speech-start or text events. Outgoing acknowledgements that previously
played during a handoff may now be cancelled by the earlier session reset.
