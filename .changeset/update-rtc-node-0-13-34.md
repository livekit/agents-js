---
'@livekit/agents': patch
---

chore(deps): update @livekit/rtc-node to 0.13.34

Ports data streams over to the rust livekit-ffi implementation, replacing the
TypeScript one (livekit/node-sdks#697). Data streams v2 brings single-packet
streams and DEFLATE compression, roughly doubling throughput.

Behavior changes worth noting for anything reading a stream:

- Errors encountered while reading an incoming stream now propagate to the
  caller instead of being logged and dropped, so a handler that awaits
  `readAll()` needs to handle rejections. Both of our stream handlers
  (`RoomIO.onUserTextInput` and `RoomSessionTransport.onByteStream`) already do.
- An in-flight stream is now terminated with an error when either side fully
  reconnects, where previously the receiver could be handed a payload that was
  silently missing the chunks lost during the outage.
- Incoming streams are capped at 5gb by default, overridable per room via
  `dataStream.maxPayloadByteLength` on `room.connect`.
- `sendText` and `sendFile` accept a new `compress` option (default `true`).
