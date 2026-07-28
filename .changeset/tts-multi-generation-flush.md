---
'@livekit/agents': patch
---

fix(inference): don't stop TTS synthesis at the first gateway `done`

Several inference gateway providers answer one `session.flush` with more than one generation,
splitting at roughly 1kB of text or 35s of audio and sending a `done` after each. A probe of
`inworld/inworld-tts-2` saw 6 `done` events for a single flush, the first covering 39.4s of
the 201.0s the session went on to produce.

The client treated the first `done` as the end of synthesis, so a reply longer than one
generation was cut off after 20-80% of its audio while the transcript committed all of it. It
also released the websocket back into the `ConnectionPool` while the gateway was still
streaming, so the next reply picked up that socket and spoke the previous reply's leftover
audio. Because the gateway session is FIFO and never reset, each reply then queued behind the
last one's unsynthesized text and the lag compounded — in the trace this came from, replies
fell up to 113s behind and 9 of 11 were never audible.

`done` is now treated as a generation boundary. The client keeps reading and only ends the
flush once the session has stayed quiet, which both delivers the whole reply and means a
socket is only ever recycled after it has been observed to be idle. The wait for silence is
capped by how much synthesized audio is still unplayed, so it costs nothing while audio is
playing out and collapses to near zero on replies too short for the gateway to split.
