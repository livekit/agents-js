---
'@livekit/agents': patch
---

Add MCP toolset refresh and persistent filtering, support HTTP header updates, and preserve intentional resolver errors. Require finite connection and request timeouts in milliseconds. Keep realtime tools in sync when discovery or filters change during an agent greeting. Retain refreshes queued during discovery or publication, and allow shutdown while SSE startup is stalled.
