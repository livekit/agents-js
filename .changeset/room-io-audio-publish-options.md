---
'@livekit/agents': patch
---

Respect `outputOptions.audioPublishOptions` when publishing the agent's audio track. `ParticipantAudioOutput.publishTrack()` previously ignored the configured `trackPublishOptions` and always published with hardcoded defaults, making it impossible to disable DTX/RED on the output track.
