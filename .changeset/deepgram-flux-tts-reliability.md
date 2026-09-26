---
'@livekit/agents-plugin-deepgram': patch
---

fix(deepgram): make Flux TTS retries and batch failures behave

Three faults in the Flux TTS (`/v2/speak`) client, each of which turned a recoverable
failure into silence or a wrong result:

- **A streaming retry lost the utterance.** `SynthesizeStream.input` is created once and
  never reset between retry attempts, so text consumed by the first attempt was gone by
  the second: the retry sent nothing, and the stream ended successfully having spoken
  nothing. Each flushed segment's words are now buffered and replayed, and the reader of
  `input` runs once for the life of the stream rather than once per attempt, so a retry
  can no longer race a leftover reader for the caller's text. As in the Python base
  class, a segment that already started playing is not replayed — repeating its opening
  words to the listener would be worse than failing the turn.
- **The batch path always dialled TLS.** `request` was imported from `node:https`
  unconditionally, so any non-`https` `baseUrl` — the form the streaming path already
  accepts — became a TLS handshake against a plain HTTP port. The transport now follows
  the URL scheme, and `ws://`/`wss://` are normalized.
- **A truncated batch response was reported as success.** Node signals a severed body as
  `Error('aborted')`, the same message a caller-side abort produces; that was discarded,
  and the following `close` flushed the partial buffer and resolved. Completion is now
  driven by `end`, and a body that stops early raises a connection error — retryable when
  no audio has been emitted yet, since the base `ChunkedStream` forwards a failed
  attempt's frames to the consumer and retrying after partial audio would splice two
  synthesis runs together.

Also stops the `abandoned queue reads` unit tests from resolving `@livekit/agents` inside
a test body, which cost seconds on a cold cache and pushed whichever test ran first past
vitest's default timeout under load.
