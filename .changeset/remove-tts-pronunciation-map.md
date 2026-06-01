---
'@livekit/agents': patch
---

Remove the `ttsPronunciationMap` Agent option (and the `TTSPronunciationMap` type). Use the general `tts_text_transforms` / `replace` text transform for pre-TTS pronunciation replacements instead.
