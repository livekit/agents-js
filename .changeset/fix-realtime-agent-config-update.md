---
'@livekit/agents-plugin-openai': patch
---

Fix `Unsupported item type: agent_config_update` thrown by the OpenAI Realtime plugin when an `Agent` is constructed with tools or instructions. `AgentActivity` inserts internal `agent_config_update` chat items on enter and on tool / instructions changes; the realtime plugin's chat-context sync now filters them out before computing the diff. `agent_handoff` items are also filtered as defense-in-depth, matching the non-realtime path's `chatCtx.copy({ excludeHandoff: true, excludeConfigUpdate: true })` (agent_activity.ts:666).
