---
'@livekit/agents-plugin-krisp': patch
---

Fix Krisp-processed audio being invisible to the rest of the pipeline

The LiveKit Cloud backend is reached through `createRequire`, which resolves the internal
package's `require` condition and so loads the CJS build of `@livekit/rtc-node` next to the
ESM one the framework uses. Frames returned by that backend were instances of the CJS copy's
`AudioFrame`, so every `instanceof AudioFrame` downstream failed. Adaptive interruption saw
zero audio and classified every barge-in as a backchannel, making it impossible to interrupt
an agent that had noise cancellation enabled. Frames are now adopted into the local binding
before leaving the filter, sharing their samples rather than copying them.
