---
'@livekit/agents': patch
---

fix(voice): attribute playback evidence to its own segment on shared audio outputs (AGT-3148, follow-up to #1966).

The interrupted-commit gate compared the shared output's segment counter against a snapshot taken at task creation, so a straggler frame from a previous interrupted speech (whose `reader.read()` resolved after its abort) could bump the counter and commit a never-played reply as `partial` with full-text fallback. The gate now requires `ownSegmentIndex` — the segment count read _after_ the first of this segment's frames was accepted by `captureFrame` — which records the playout segment the frames actually landed in. Both gate sites now share `hasOwnPlaybackEvidence`.

The `PLAYBACK_STARTED` listener (which outlives forwarding since #1966) previously accepted any event once the segment had captured a frame, so a stale event from an overlapping segment — e.g. an avatar's late `lk.playback_started` RPC, or the next speech starting during this one's interruption teardown — could resolve the wrong segment's `firstFrameFut`, flipping the agent to `speaking` with a foreign timestamp and committing unheard text. The listener now only honors an event while the output's segment counter still points at its own segment, failing closed on ambiguity (genuine partial playback still commits through the playback-position evidence).
