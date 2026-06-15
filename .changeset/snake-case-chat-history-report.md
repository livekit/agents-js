---
'@livekit/agents': patch
---

Serialize chat-item `toJSON()` output in snake_case (e.g. `new_agent_id`, `call_id`, `arguments`, `is_error`, `created_at`) to match the Python session-report schema. The uploaded `chat_history.json` previously used camelCase keys, so LiveKit Cloud's parser rejected required fields (e.g. `agent_handoff.new_agent_id`). Constructor/`create()` APIs are unchanged.
