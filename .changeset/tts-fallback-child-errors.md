---
'@livekit/agents': patch
---

Stop `tts.FallbackAdapter` from failing the session while it is falling back. Child `error` events were re-emitted verbatim, so a non-retryable provider failure (an ElevenLabs 401, say) reached `AgentSession` as an unrecoverable `tts_error` and closed the session even though the next instance was already serving audio — and the recovery probe re-raised it every `recoveryDelayMs` for as long as that provider stayed down. Child errors are now absorbed; terminal failure still surfaces as the adapter's own `APIConnectionError` once every instance has failed. `close()` also removes only the listeners the adapter registered, instead of every listener on TTS instances the caller owns. `ChunkedStream`'s detached main task now swallows its rejection the way `SynthesizeStream`'s already does, so a provider failure reported on the `error` event cannot also surface as an unhandled rejection.
