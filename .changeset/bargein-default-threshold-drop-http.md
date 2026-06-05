---
'@livekit/agents': patch
---

Adaptive interruption detection now omits the threshold from `session.create` unless the user explicitly overrides it, letting the gateway apply its fetched default (surfaced via `default_threshold` on `session.created`). The HTTP transport has been dropped — detection always connects over WebSocket and always requires LiveKit credentials, and its base URL now defaults from `LIVEKIT_INFERENCE_URL` instead of `LIVEKIT_REMOTE_EOT_URL`. Inference requests also send an `X-LiveKit-Worker-Token` header when `LIVEKIT_WORKER_TOKEN` is set (hosted agents); a token supplied via the `--worker-token` CLI flag is now re-exported into the environment so forked job subprocesses inherit it and include the header. The `X-LiveKit-Agent-Id` header is now only attached once the room is connected to avoid leaking an unset local-participant SID.
