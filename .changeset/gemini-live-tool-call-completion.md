---
'@livekit/agents-plugin-google': patch
---

Don't start a new Gemini Live generation for the content-free `generationComplete` (or empty transcription) that follows a tool call. Its `input_speech_started` interrupted the speech that made the call, cutting its line and dropping the tool's result. A pending `generateReply()` still gets its generation from a bare `turnComplete`.
