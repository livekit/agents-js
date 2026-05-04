---
"@livekit/agents": patch
---

Harden RecorderIO teardown by fencing writes before channel closure and stopping
the forward task first, preventing repeated closed WritableStream write errors on disconnect.
Also centralize writable-stream closed error detection in utils and add regression tests.
