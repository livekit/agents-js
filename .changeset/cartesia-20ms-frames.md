---
'@livekit/agents-plugin-cartesia': patch
---

Split Cartesia audio into 20 ms frames instead of 100 ms. The plugin holds the last frame back until the next one arrives so it can mark the final frame, and with 100 ms frames the first audio of every generation waited for Cartesia's second chunk.
