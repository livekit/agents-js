---
'@livekit/agents': patch
---

Emit the full OpenTelemetry GenAI semantic conventions on agent spans, and strip PII in-process.

Spans now carry the standard `gen_ai.*` attributes — operation, provider, request/response
model, per-modality token usage, finish reasons, time-to-first-chunk, tool name/type/call id,
and the `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions` /
`gen_ai.tool.definitions` content payloads — so Datadog Agent Observability, Langfuse and any
other GenAI-aware backend understands a LiveKit trace without a custom mapping. The session
maps to `invoke_workflow`, an agent turn to `invoke_agent`, inference to `chat`, and tool
execution to `execute_tool`. Existing `lk.*` attributes are unchanged.

Message content is captured by default and can be turned off process-wide with
`telemetry.genAI.setCaptureContent(false)` or
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false`.

When a session has redaction enabled, every PII attribute — `lk.pii.*` and the GenAI content
attributes, whose names the convention fixes — is now removed before any exporter observes the
span, including an exporter you registered yourself. Previously this stripping happened only
at the LiveKit Cloud collector, so a third-party exporter sharing the tracer provider received
unredacted content.
