---
'@livekit/agents': patch
---

Keep the synchronized transcript in step with the audio when TTS alignments end mid-word (for example ElevenLabs character alignments). The word walk no longer jumps ahead to a later repeat of the same letters, and pacing counts syllables per word rather than per piece.
