---
'@livekit/agents-plugin-openai': patch
---

fix(openai): include `?model=` on Responses-API and realtime STT WebSocket URLs

OpenAI-compatible gateways (LiteLLM, Cloudflare AI Gateway, Helicone,
Portkey, etc.) can only see the URL at the WebSocket upgrade — they
cannot read the subsequent `session.update` / `response.create` frame to
determine which backend to dial. The `realtime/realtime_model.ts`
conversational endpoint already includes the model in the upgrade URL;
this aligns the Responses-API LLM and realtime STT paths with the same
convention. OpenAI's native endpoints accept and ignore the parameter,
so this is a no-op for direct connections.
