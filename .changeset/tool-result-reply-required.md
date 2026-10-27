---
'@livekit/agents': patch
---

Add `llm.ToolResult` so a function tool can control the follow-up reply. Return `new ToolResult(output, { replyRequired: false })` to keep the output in chat history without requesting a reply. It also works as a handoff's `returns` and as a deferred tool result after `ctx.update()`.
