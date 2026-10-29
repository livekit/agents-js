---
'@livekit/agents-plugin-google': patch
---

Connect a new Gemini Live session once instead of twice. The first setup frame was built before the framework applied the agent's instructions, chat context and tools, so every session with tools connected, then reconnected right away to pick them up. The first connect now waits one task, which is enough for that configuration to land.
