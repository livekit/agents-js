---
'@livekit/agents': patch
---

Support granular recording options in `AgentSession.start`. The `record` option now accepts `boolean | RecordingOptions` (`{ audio, traces, logs, transcript }`); a boolean maps to all-on/all-off and a partial object merges onto all-on, so omitted keys default to `true`. Each category independently gates audio capture, trace export, log export, and transcript upload, mirroring the Python SDK and matching the documented granular form.
