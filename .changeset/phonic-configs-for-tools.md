---
'@livekit/agents-plugin-phonic': patch
---

Add `configsForTools` to the Phonic realtime model — a per-tool config passthrough (`[{ name, ... }]`) where each object may carry up to the full behavior set (`wait_for_speech_before_tool_call`, `forbid_speech_after_tool_call`, `forbid_tool_call_after_speech`, `allow_tool_chaining`); omitted fields fall back to the plugin defaults. Replaces the earlier `forbidSpeechAfterToolCall: string[]` option and adds `forbid_tool_call_after_speech` (Phonic drops the tool call if the agent already spoke that turn).
