---
'@livekit/agents': patch
---

Fix TTS TTFB attribution: `tts_node` TTFB is now anchored on the time the first sentence is sent to the TTS provider instead of the time the first LLM token arrives, so upstream text generation and tokenization latency is no longer counted as TTS latency.
