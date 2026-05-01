---
'@livekit/agents': patch
'@livekit/agents-plugin-anam': patch
'@livekit/agents-plugin-bey': patch
'@livekit/agents-plugin-lemonslice': patch
'@livekit/agents-plugin-trugen': patch
---

Add `voice.AvatarSession` base class and port the asymmetric-detach warning from the Python `TranscriptSynchronizer`. The new base class registers `aclose` as a job shutdown callback and warns when an avatar session is started after `AgentSession.start()` has already wired an audio output. The transcript synchronizer now tracks `_audioAttached` / `_textAttached` via `onAttached` / `onDetached` and logs a one-shot warning when audio or text is detached asymmetrically (covering external avatars and manual `session.output.audio` / `.transcription` replacement). Existing avatar plugins (anam, bey, lemonslice, trugen) now inherit from `voice.AvatarSession` and call `super.start(agentSession, room)` first.
