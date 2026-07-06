---
'@livekit/agents': patch
'@livekit/agents-plugin-deepgram': patch
'@livekit/agents-plugin-assemblyai': patch
---

Conversation-aware STT recognition (keyterms + chat context), ported from python livekit-agents PR #6039. Adds `keytermsOptions` on `AgentSession` with static `keyterms` and LLM-based `keytermDetection` (confirmation-gated), new `STTCapabilities.keyterms`/`chatContext` flags with `_updateSessionKeyterms()`/`_pushConversationItem()` hooks (forwarded by the fallback and stream adapters), keyterm support for deepgram (v1/v2), assemblyai, and livekit inference STT, and native conversation-context carryover (`agentContextCarryover`) for assemblyai u3-rt-pro.
