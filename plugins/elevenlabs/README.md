<!--
SPDX-FileCopyrightText: 2024 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# ElevenLabs plugin for LiveKit Agents

The Agents Framework is designed for building realtime, programmable
participants that run on servers. Use it to create conversational, multi-modal
voice agents that can see, hear, and understand.

This package contains the ElevenLabs plugin, which allows for voice synthesis.
Refer to the [documentation](https://docs.livekit.io/agents/overview/) for
information on how to use it, or browse the [API
reference](https://docs.livekit.io/agents-js/modules/plugins_agents_plugin_elevenlabs.html).
See the [repository](https://github.com/livekit/agents-js) for more information
about the framework as a whole.

## Realtime speech-to-text audio chunks

Configure the outgoing audio chunk duration when creating the STT instance:

```typescript
import { STT } from '@livekit/agents-plugin-elevenlabs';

const stt = new STT({
  model: 'scribe_v2_realtime',
  audioChunkDuration: 100,
});
```

`audioChunkDuration` accepts a positive integer in milliseconds and defaults to 50. At 100 ms,
continuous audio produces approximately 10 audio messages per second instead of 20, at the cost of
up to 50 ms additional buffering. Larger chunks do not pace reconnect backlogs or guarantee that
provider queue errors are avoided. Flushes send any remaining partial chunk before the commit.

This option applies only to realtime STT and is set at construction time.
