---
'@livekit/agents-plugin-phonic': patch
---

Add `configsForTools` to the Phonic realtime model — per-tool behavior overrides (`[{ name, ... }]`) forwarded to Phonic's tool config. Each entry may set `require_speech_before_tool_call`, `forbid_speech_after_tool_call`, and `forbid_tool_call_after_speech`; omitted fields fall back to the plugin defaults. See the README for details.
