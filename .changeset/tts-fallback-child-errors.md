---
'@livekit/agents': patch
---

Stop `tts.FallbackAdapter` from closing the session while it is falling back. Child `error` events were re-emitted verbatim, so one provider failure (an ElevenLabs 401, say) closed the session even though the next instance was already serving audio, and the recovery probe re-raised it every `recoveryDelayMs`. Child errors are now absorbed and logged with the provider's own error; the adapter still reports `APIConnectionError` once every instance has failed. A recovery probe that errors no longer counts as recovered, `close()` removes only the adapter's own listeners, and a failed `ChunkedStream` no longer surfaces as an unhandled rejection.
