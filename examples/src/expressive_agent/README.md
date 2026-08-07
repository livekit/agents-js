<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Expressive Agent

A free-form voice agent that demonstrates Expressive Mode. There is no task or
tool: talk to it like a friend and it adapts its delivery to the conversation.

The pipeline uses LiveKit Inference with AssemblyAI Universal 3.5 Pro, Gemma 4
31B, Fish Audio S2.1 Pro by default, and the LiveKit cloud turn detector. It
also enables adaptive interruption handling and preemptive generation.

## Configuration

Dispatch metadata can select the voice and toggle expressive output:

```json
{ "expressive": true, "tts": "fishaudio" }
```

Supported `tts` values are `fishaudio`, `inworld`, `cartesia`, and `xai`.
Malformed metadata falls back to all defaults; an unknown voice falls back to
Fish Audio while preserving the requested expressive setting. The active
settings are published as the agent participant attributes `expressive`,
`tts_provider`, and `tts_label`.

The explicit worker name remains `expressive-agent-js`, including for cue-cli
sessions.
