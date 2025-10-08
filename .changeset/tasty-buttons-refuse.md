---
'@livekit/agents': patch
---

Ensure tool calls are not aborted when preamble text forwarding stops. It refines the execution flow so that cleanup of preamble forwarders does not propagate an abort to in-flight tool executions.
