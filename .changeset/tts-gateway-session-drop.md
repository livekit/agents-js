---
'@livekit/agents': patch
---

fix(inference): treat a dropped TTS gateway session as a failed attempt

When the inference gateway ends a TTS session with `session.closed` part-way through a
reply, the JS client treated it as a successful completion. That single mistake had two
consequences. The rest of the reply's text was discarded with no error, no warning and no
retry — in the trace this came from, a ~9000-character reply had only 2017 characters
submitted before the drop. And the gateway websocket went back into the `ConnectionPool`
while the gateway was still mid-synthesis, so the next reply picked it up and read the
previous reply's outstanding audio as its own: after one barge-in the following reply spoke
53.8s of the previous answer while the transcript showed the new one.

The dropped session now flushes the audio it did produce, marks that segment's last frame
final, and rejects with a retryable `APIStatusError`, so the socket is evicted and the retry
finishes the reply. Socket reuse is additionally gated on having observed the gateway's
`done`.
