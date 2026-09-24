---
'@livekit/agents': patch
---

Stop `tts.FallbackAdapter` from closing the session while it is falling back. Child `error` events were re-emitted verbatim, so one provider failure (an ElevenLabs 401, say) closed the session even though the next instance was already serving audio, and the recovery probe re-raised it every `recoveryDelayMs`. The adapter now absorbs a child's failure when it recovers from it, logging the provider's own error, and reports its own error when it can't: every instance failed, or speech was already cut off. A recovery probe that errors no longer counts as recovered, `StreamAdapter` wrappers no longer stay subscribed to non-streaming instances, `close()` removes only the adapter's own listeners, and a failed `ChunkedStream` no longer surfaces as an unhandled rejection.
