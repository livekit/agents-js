---
'@livekit/agents': patch
---

feat(voice): add `CustomEvent` (proto-native) over remote-session wire

Bumps `@livekit/protocol` to `^1.46.3` and wires the new
`AgentSessionEvent.custom_event` (livekit/protocol#1588) through
`SessionHost` / `RemoteSession`.

The event is forwarded **proto-native**: callers construct and emit a
`pb.CustomEvent` directly; the framework forwards it as-is. No wrapper
type, no dict↔`Struct` round-trip.

```ts
import { AgentSession as pb } from '@livekit/protocol';
import { Struct } from '@bufbuild/protobuf';

session.emit(
  'custom_event',
  new pb.CustomEvent({
    type: 'anomaly_detected',
    payload: Struct.fromJson({ score: 0.92 }),
  }),
);
```

Also unlocks `AgentSessionEvent.FunctionToolsStarted`,
`AgentSessionEvent.EotPrediction`, and `SessionRequest.UpdateIO` for
downstream consumers.
