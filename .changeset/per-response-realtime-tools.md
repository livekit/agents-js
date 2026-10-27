---
'@livekit/agents': patch
'@livekit/agents-plugin-google': patch
'@livekit/agents-plugin-phonic': patch
'@livekit/agents-plugin-xai': patch
---

Add a `tools` option to `AgentSession.generateReply()` that limits the reply to the listed tool and toolset IDs. Realtime models that support per-response tool choice, such as OpenAI, now get the tools and tool choice on `response.create`. Other realtime models swap the session tools and tool choice for the reply and then restore them. Google and Phonic log a warning and ignore per-response tools. xAI no longer reports per-response tool choice support.
