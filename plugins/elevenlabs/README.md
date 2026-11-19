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

## Scribe v3 Live turn prediction

Enable server-side turn prediction with `scribe_v3_live`:

```ts
import { STT } from '@livekit/agents-plugin-elevenlabs';
import { VAD } from '@livekit/agents-plugin-silero';

const speechToText = new STT({
  model: 'scribe_v3_live',
  commitStrategy: 'turn_prediction',
  serverVad: { vadSilenceThresholdSecs: 2 },
  vad: await VAD.load(),
});
```

Use STT turn detection on the `AgentSession` to treat server commits as turn boundaries.
`serverVad` is optional and configures the VAD fallback. Other models do not support
`turn_prediction`.

> **Warning:** With `scribe_v3_live` and `turn_prediction`, the server can force a segment commit
> after approximately 36 seconds of audio while the user is still speaking. Without a local `vad`
> passed to `STT`, the plugin treats that commit as end of speech and can trigger an early response.

The optional local `vad` helps detect forced segment commits during long turns. The plugin keeps
the turn open when the last turn probability is below 0.9, 34-38 seconds of audio have been sent
since the previous server commit, and local VAD still detects speech. The final transcript is
emitted immediately. This is a heuristic because the provider does not report why it committed.

If no new segment text arrives, the plugin emits end of speech after the server silence threshold
plus 0.5 seconds (2 seconds with the server default). New segment text cancels this fallback and
the plugin waits for that segment's final transcript. The timer can expire even if background audio
keeps local VAD in the speaking state. Without a local `vad`, automatic server commits continue to
end speech. Before reconnecting, the plugin finishes any deferred turn. If local VAD fails, the
plugin warns and disables the guard for that connection while transcription continues.

With a local `vad`, the plugin also closes a turn opened by a partial transcript if no commit
arrives and VAD stays silent for the server silence threshold plus 0.5 seconds (2 seconds by
default). Further partials do not extend this deadline. VAD speech cancels the timer; when speech
ends, a fresh silence window starts. This emits only end of speech, without promoting the partial
to a final transcript. The fallback is limited to `scribe_v3_live` with an automatic commit strategy
and is disabled if local VAD fails.

The other commit strategies are `manual` and `vad`. If `commitStrategy` is omitted, the plugin uses
`vad` when `serverVad` is an object and `manual` otherwise. An explicit strategy takes precedence.
Calling `stt.updateOptions({ commitStrategy: ... })` reconnects every active stream, so change the
strategy between turns. A stream-level strategy update applies to its owning STT and sibling streams.
