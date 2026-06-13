---
'@livekit/agents': patch
---

Add `TcpAudioInput`/`TcpAudioOutput` for console-mode sessions, porting the Python `tcp_console` audio IO: inbound `audio_input` frames are resampled from the 48 kHz wire rate to the 24 kHz agent rate and fed to the STT pipeline, while the agent's TTS frames are resampled back up and streamed as `audio_output` messages. The output drives the flush/clear playout handshake, blocking the agent turn until the broker reports `audio_playback_finished` (or reporting an interruption when the buffer is cleared). `SessionHost` now accepts optional audio IO and routes inbound `audio_input`/`audio_playback_finished` messages to it.
