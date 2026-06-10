---
'@livekit/agents': patch
---

Add `TcpSessionTransport`, a `SessionTransport` that frames protobuf session messages over a raw TCP socket (4-byte big-endian length prefix, 1 MiB cap, `TCP_NODELAY`), mirroring the Python implementation. Also handle the `updateIo` session request in `SessionHost`, toggling input/output audio and transcription. This is the transport plumbing that lets a local broker (e.g. the LiveKit CLI session daemon) drive a Node agent over TCP.
