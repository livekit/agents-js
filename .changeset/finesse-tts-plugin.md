---
'@livekit/agents-plugin-finesse': patch
---

Add a Finesse TTS plugin that streams speech over the Finesse realtime WebSocket, with server-side cancel on interruption. An optional `useDirectSession` connects straight to the synthesis GPU in your account's region for lower first-audio latency.
