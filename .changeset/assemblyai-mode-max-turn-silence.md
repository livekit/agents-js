---
'@livekit/agents-plugin-assemblyai': patch
---

Stop copying `minTurnSilence` into an unset `maxTurnSilence` when a `mode` preset is selected, so the preset controls max turn silence as documented.
