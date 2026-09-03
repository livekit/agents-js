---
'@livekit/agents': minor
---

Emit the full OpenTelemetry GenAI semantic conventions on agent spans, and keep PII away from
third-party exporters.

Spans now carry the standard `gen_ai.*` attributes — operation, provider, request/response
model, per-modality token usage, finish reasons, time-to-first-chunk, tool name/type/call id,
and the `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions` /
`gen_ai.tool.definitions` content payloads — so Datadog Agent Observability, Langfuse and any
other GenAI-aware backend understands a LiveKit trace without a custom mapping. The session
maps to `invoke_workflow`, an agent turn to `invoke_agent`, inference to `chat` (realtime turns
to `generate_content` on their own nested span), and tool execution to `execute_tool`. Existing
`lk.*` attributes and span names are unchanged.

**Breaking for third-party exporters:** conversational content, tool payloads and other user
data are now stripped in-process before any exporter that is not LiveKit Cloud's. If your
Datadog/Langfuse/OTLP pipeline is meant to show conversations, grant it explicitly:

```ts
telemetry.setTracerProvider(provider, { registerSpanProcessor, allowPii: true });
```

or set `LIVEKIT_TELEMETRY_ALLOW_PII=1` when the framework adopts the ambient OpenTelemetry
provider and there is no call site to pass it. What LiveKit Cloud receives is unchanged and
stays governed by the project's PII setting in the dashboard; when that setting mandates
redaction, PII is withheld from every destination including Cloud, and `allowPii` does not
weaken it.

Message content can also be dropped entirely with `telemetry.genAI.setCaptureContent(false)`
or `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false`.
