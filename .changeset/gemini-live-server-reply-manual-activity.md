---
'@livekit/agents-plugin-google': patch
---

With manual activity detection, a generation Gemini starts on its own (such as the reply to a tool result) no longer emits `input_speech_started`: the framework answered it by opening a user activity, and Gemini cut its own reply off.
