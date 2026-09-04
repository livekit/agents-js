---
'@livekit/agents': minor
---

Emit the full OpenTelemetry GenAI semantic conventions on agent spans.

Spans now carry the standard `gen_ai.*` attributes — operation, provider, request/response
model, per-modality token usage, cached tokens, finish reasons, time-to-first-chunk, tool
name/type/call id, and the `gen_ai.input.messages` / `gen_ai.output.messages` /
`gen_ai.system_instructions` / `gen_ai.tool.definitions` content payloads — so Datadog Agent
Observability, Langfuse and any other backend that reads the conventions (OTel v1.37+)
renders a LiveKit trace without a custom mapping. The session maps to `invoke_workflow`, an
agent turn to `invoke_agent`, inference to `chat` (realtime turns to `generate_content` on
their own nested span), and tool execution to `execute_tool`.

`gen_ai.provider.name` now reports the registry spelling the convention requires. Plugins
expose `provider` either as a display name (`MistralAI`, `AWS Bedrock`, `Vertex AI`) or as the
client's base-URL host (`api.openai.com`, `api.anthropic.com`); both are normalized, so
`openai`, `anthropic`, `mistral_ai`, `aws.bedrock`, `gcp.vertex_ai`, `gcp.gemini`, `x_ai`,
`groq` and `perplexity` are recognized by GenAI backends. A provider outside the registry
keeps its own id, which the convention allows.

Conversational content reaches every configured exporter, as before. To withhold it from a
third-party pipeline while LiveKit Cloud keeps receiving it, pass `allowPii: false`:

```ts
telemetry.setTracerProvider(provider, { registerSpanProcessor, allowPii: false });
```

or set `LIVEKIT_TELEMETRY_ALLOW_PII=0` when the framework adopts the ambient OpenTelemetry
provider and there is no call site. What LiveKit Cloud receives stays governed by the
project's PII setting in the dashboard; when that mandates redaction, PII is withheld from
every destination and `allowPii` does not weaken it. Content can be dropped entirely with
`telemetry.genAI.setCaptureContent(false)` or
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false`.
