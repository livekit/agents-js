---
'@livekit/agents': patch
---

Expose `AgentSessionOptions.ttsReadIdleTimeout` and `AgentSessionOptions.forwardAudioIdleTimeout` to configure the two pipeline stall guards in `performTTSInference` and `performAudioForwarding`. Useful for custom LLM/TTS backends whose first-token latency can legitimately exceed the previous 10s default. Defaults remain 10 seconds, preserving existing behavior.
