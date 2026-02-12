---
"@livekit/agents": patch
---

Dispose native FFI resources before process.exit() in job shutdown to prevent libc++abi mutex crash
