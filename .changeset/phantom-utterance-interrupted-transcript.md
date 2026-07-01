---
"@livekit/agents": patch
---

Fix interrupted assistant speech being dropped from chat history when the audio output provides no playback-aligned transcript. On a mid-playout interruption, `forwardedTextFor` (and the realtime reply path) returned `synchronizedTranscript ?? ''`, so an interrupted-but-heard reply produced no `conversation_item_added` and was missing from `chatCtx` — common with avatar outputs that don't emit a synchronized transcript. The commit now falls back to the forwarded generation text (`textOut.text`), matching the Python SDK's `_ForwardOutput.forwarded_text` behavior.
