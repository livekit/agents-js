---
'@livekit/agents': patch
---

Drain accepted session responses and ordered events before shutdown, cancel expired remote runs, and surface transport send failures. Add `RemoteSession.waitForReady()` to retry startup pings.

Cancel pending transcription reads and join reply cleanup while preserving interrupted text. Release Room stream writers after cancelled sends and close TCP connections on oversized frames.

Release unused speech text branches and join synthesis input cleanup so streaming `say()` finishes on interruption or output failure.

Keep transcription input available during deferred hook setup. Drain independent pipeline text after early TTS completion and always release segment queues when writer closure fails.

Release pending SDK input readers before joining public async-generator transcription hooks, so session close and remote-run cancellation finish without late history changes.

Cancel activity-owned transcription inputs while public hook setup is pending, including setup that reads input before returning its output.
