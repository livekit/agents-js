---
'@livekit/agents-plugin-phonic': patch
---

Add `configsForTools` to the Phonic realtime model — per-tool behavior overrides (`[{ name, ... }]`) forwarded to Phonic's tool config. Each entry may set `require_speech_before_tool_call`, `forbid_speech_after_tool_call`, and `forbid_tool_call_after_speech`; omitted fields fall back to the plugin defaults. The existing `forbidSpeechAfterToolCall: string[]` option is deprecated but still supported — it folds into `configsForTools` and logs a warning. See the README for details.
