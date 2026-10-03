---
'@livekit/agents-plugin-azure': patch
'@livekit/agents-plugin-baseten': patch
'@livekit/agents-plugin-deepgram': patch
'@livekit/agents-plugin-inworld': patch
'@livekit/agents-plugin-openai': patch
'@livekit/agents-plugin-sarvam': patch
'@livekit/agents-plugin-xai': patch
---

Propagate STT connection and provider failures through API error recovery. Release failed connections' audio readers before reconnecting, preserve error types when retries are exhausted, and clean up Azure recognition startup failures. Keep provider error payloads in redactable log fields and release unused OpenAI streams.
