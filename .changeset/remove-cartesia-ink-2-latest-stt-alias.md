---
'@livekit/agents': patch
---

Remove the `cartesia/ink-2-latest` alias from the Cartesia inference STT model type hints. The alias still works at runtime; dated and `-latest` Cartesia snapshot aliases are no longer surfaced in the SDK types.
