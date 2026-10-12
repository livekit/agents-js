---
'@livekit/agents': patch
---

Stop publishing the deprecated `Transcription` data packet when every client rebuilds transcription events from `lk.transcription` text streams. Port of python `livekit/agents#7240`. Agents previously published every transcription twice over the reliable data channel, which saturates it and delays unrelated reliable traffic. The legacy packet is now skipped once every remote STANDARD participant advertises `clientProtocol >= 3` (`CLIENT_PROTOCOL_TRANSCRIPTION_STREAMS`); SIP, ingress, agent, connector and bridge participants never render legacy transcripts and so do not hold it open, and the session's own avatar worker is excluded. The `lk.transcription` stream is unaffected and still reaches every participant.
