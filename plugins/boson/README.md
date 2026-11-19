<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->
# Boson plugin for LiveKit Agents

This package adapts the Boson Higgs realtime WebSocket API to LiveKit Agents' `RealtimeModel`.
LiveKit owns room audio, interruption plumbing, transcript IO, and worker lifecycle; this plugin
adapts those operations to Boson's OpenAI-compatible realtime protocol subset.

## Installation

```bash
pnpm add @livekit/agents-plugin-boson
```

## Usage

Set `BOSON_API_KEY`, then create a realtime model:

```ts
import { voice } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-boson';

const session = new voice.AgentSession({
  llm: new realtime.RealtimeModel({
    inputAudioTranscriptionModel: 'higgs-stt-3.1',
  }),
});
```

The defaults use `wss://api.boson.ai/v1/realtime`, model `higgs-realtime`, voice `default`,
24 kHz PCM audio, and server VAD. Output is single-modality: use `outputModalities: ['audio']`
or `['text']`. Pass `apiKey: null` explicitly for an unauthenticated local endpoint.

## Model Options

| Option | Description |
| --- | --- |
| `url` | WebSocket endpoint. `http` and `https` are normalized to `ws` and `wss`. |
| `apiKey` | Bearer token. Omit to read `BOSON_API_KEY`; pass `null` to disable authentication. |
| `model` | Server model name. Defaults to `higgs-realtime`. |
| `voice` | Output voice. Defaults to `default`. |
| `outputModalities` | Exactly `['audio']` (default) or `['text']`; mixed and empty lists are rejected. |
| `temperature` | Optional sampling temperature; omission uses the server default. |
| `maxOutputTokens` | Response token cap, or `'inf'`. |
| `toolChoice` | Session-level tool selection mode. |
| `speed` | Synthesized audio playback rate. Defaults to `1`. |
| `turnDetection` | Server VAD configuration. Pass `null` or `false` for client-driven commits. |
| `inputAudioTranscription` | Raw input transcription configuration. Unsupported `prompt` is removed. |
| `inputAudioTranscriptionModel` | Convenience option for the user transcription model. |
| `inputAudioTranscriptionLanguage` | Convenience option for the ASR language hint. |
| `inputAudioNoiseReduction` | `'near_field'`, `'far_field'`, an object, or `null`. |
| `truncation` | `'auto'` (default) or `'disabled'`. |
| `queryParams` | Extra query parameters merged into `url`. |
| `maxSessionDuration` | Milliseconds before a planned connection recycle, or `null`. |
| `connOptions` | Connection timeout and retry policy. |

The default turn detection configuration is:

```ts
{
  type: 'server_vad',
  create_response: true,
  interrupt_response: true,
  prefix_padding_ms: 300,
  silence_duration_ms: 500,
  threshold: 0.55,
}
```

Higgs currently cancels an active response whenever server VAD detects speech, regardless of the
`interrupt_response` value. Duplicate client cancellation suppression therefore follows whether
server VAD is enabled, not that field.

Input transcription events are enabled only when the transcription configuration has a non-empty
`model`. A block containing only a language still lets the server use ASR internally but does not
produce client-facing final transcript events.

The server does not persist sessions. Reconnects replay the local conversation as text, including
completed function calls and outputs. User audio without a transcript cannot be replayed, so the
default 20-minute planned recycle is enabled only when an input transcription model is configured.
Set `maxSessionDuration: null` to disable planned recycling.

Boson accepts but ignores per-response tools and tool choice. The plugin therefore scopes tools at
the session level. System and developer conversation items are not stored by Boson; use agent
instructions for persistent directives.

## Protocol Behavior

The plugin sends `session.update`, input audio append/commit/clear, conversation item
create/delete/truncate, and response create/cancel events. It handles text and audio responses,
audio transcripts, input transcription, function calls, interruptions, and correlated errors.

Only function tools have a Boson wire representation. Other provider tools are omitted with one
warning per session. Function calls and outputs are retained in the local conversation and replayed
after reconnect, using the original unshortened server IDs.

Boson merges consecutive same-role speech into one item and may re-emit that item with cumulative
text. The plugin updates the existing local item and preserves the first speech fragment's turn
timestamp across later merged transcriptions.

Boson has no insert-at-head operation: `previous_item_id: null` appends when the server already has
items. A head insertion, head text replacement, or reorder therefore rebuilds the remote
conversation in target order. Items with no replayable text, such as an audio turn still waiting
for transcription, are reported and return on a later sync once text is available.

Invalid API key close code `3000` and billing refusal close code `4429` are terminal. An announced
idle timeout is also terminal. An announced server max duration and the configured planned recycle
open a fresh connection without consuming a retry or reporting a recoverable failure.

Expected client/server races (`response_not_active`, `response_id_mismatch`,
`voice_output_task_ongoing`, and correlated `invalid_previous_item_id`) are suppressed. Other
errors retain their client event correlation so only the matching reply or chat-context operation
is failed.

## Limitations

- Video input is unsupported.
- Output cannot combine text and audio modalities.
- Conversation storage supports only user and assistant messages; use session instructions for
  system and developer directives.
- Audio uses mono 24 kHz PCM.
