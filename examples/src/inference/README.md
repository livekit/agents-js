<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Inference

A minimal voice agent powered end-to-end by [LiveKit Inference](https://docs.livekit.io/agents/models/inference.md). The playground exposes STT, LLM, and TTS pickers that swap the corresponding component live via RPC, so you can hear how each provider feels in the same conversation without restarting the session.

## How the live swap works

The playground sends an RPC on every dropdown change:

```ts
room.localParticipant.performRpc({
  destinationIdentity: agent.identity,
  method: 'set_stt_model' | 'set_llm_model' | 'set_tts_model',
  payload: JSON.stringify({ value: 'deepgram/nova-3' }),
});
```

The agent registers one handler per control. STT and TTS call `updateOptions({ model })`; LLM swaps replace the session LLM instance before the next reply.

## Run locally

```bash
pnpm build && node ./examples/src/inference_agent.ts dev --log-level=debug
```
