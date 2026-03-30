---
"@livekit/agents": patch
"@livekit/agents-plugin-deepgram": patch
"@livekit/agents-plugin-openai": patch
---

fix: Address 6 bugs from Detail scan (March 25)

- inference/llm: pass abort signal to OpenAI SDK and check abort in outer streaming loop
- llm/fallback_adapter: call tryRecovery() before throwing on mid-stream failure
- openai/realtime: clear responseCreatedFutures on reconnect to prevent generateReply() hang
- deepgram/tts: reject on network errors instead of swallowing them
- cpu: remove Math.max clamp in cgroup v1 so fractional CPU limits are reported correctly
- openai/responses: handle response.failed event in HTTP streaming
