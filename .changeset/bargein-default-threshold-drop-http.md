---
'@livekit/agents': patch
---

Adaptive interruption detection now omits the threshold from `session.create` unless the user explicitly overrides it, letting the gateway apply its fetched default (surfaced via `default_threshold` on `session.created`). The HTTP transport has been dropped — detection always connects over WebSocket and always requires LiveKit credentials, and its base URL now defaults from `LIVEKIT_INFERENCE_URL` instead of `LIVEKIT_REMOTE_EOT_URL`. Inference requests also send an `X-LiveKit-Worker-Token` header when `LIVEKIT_WORKER_TOKEN` is set (hosted agents), and the `X-LiveKit-Agent-Id` header is now only attached once the room is connected to avoid leaking an unset local-participant SID.
