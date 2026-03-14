# CLAUDE.md

OpenTelemetry integration for distributed tracing, logging, and session report uploads.

## Key Components

- **DynamicTracer** — Runtime-switchable tracer provider wrapper. Global instance exported as `tracer`.
- **setupCloudTracer()** — Complete cloud observability setup: OTLP exporter, metadata span processor, Pino cloud log exporter. Uses JWT for auth.
- **uploadSessionReport()** — Uploads chat history (JSON), metrics (protobuf header), and audio (OGG) to LiveKit Cloud via multipart FormData.
- **MetadataLogProcessor / ExtraDetailsProcessor** — Inject room_id, job_id, logger names into all log records.

## Non-Obvious Patterns

- **Monotonic timestamp ordering**: Session report adds 1μs offsets to colliding timestamps to ensure correct dashboard display ordering.
- **Dynamic tracer provider**: Can change tracer provider mid-session (used when cloud connection establishes after startup).
- **Metadata injection**: All spans automatically tagged with room_id and job_id via `MetadataSpanProcessor`.
