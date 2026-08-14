---
'@livekit/agents-plugin-phonic': patch
---

Support Phonic's built-in tools (`choose_not_to_respond`, `keypad_input`, `natural_conversation_ending`) in the realtime model. Enable them by name via `phonicTools` and configure them with a matching `configsForTools` entry (`respond_after_sec` for `choose_not_to_respond`; `speech_before_tool_call` for the other two) — a built-in with a config is sent to Phonic as an inline object, otherwise as a bare name using its defaults.
