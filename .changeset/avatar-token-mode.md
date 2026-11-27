---
'@livekit/agents': patch
'@livekit/agents-plugin-anam': patch
'@livekit/agents-plugin-bey': patch
'@livekit/agents-plugin-did': patch
'@livekit/agents-plugin-lemonslice': patch
'@livekit/agents-plugin-liveavatar': patch
'@livekit/agents-plugin-protoface': patch
'@livekit/agents-plugin-runway': patch
'@livekit/agents-plugin-synthesia': patch
'@livekit/agents-plugin-tavus': patch
'@livekit/agents-plugin-trugen': patch
---

Add `JobContext.createParticipantToken()` and `JobContext.localParticipantIdentity`. Avatar plugins get their participant tokens from `createParticipantToken()`, so they work in token mode, where the server creates the token. An API key and secret given to a plugin still sign the token locally. The bey and trugen plugins now publish on behalf of the agent's participant, not the participant the job was dispatched for.
