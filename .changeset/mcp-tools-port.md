---
'@livekit/agents': patch
---

feat(mcp): add MCP (Model Context Protocol) server integration

Ports MCP tool support from `livekit-agents` (Python). Tools exposed by an
MCP server are fetched on activity start and merged into the agent's tool
context. Both stdio and HTTP transports (SSE + streamable HTTP) are supported.

```ts
const session = new voice.AgentSession({
  mcpServers: [new llm.MCPServerHTTP({ url: 'http://localhost:8000/sse' })],
  // ...
});
```

`@modelcontextprotocol/sdk` is an optional peer dependency: install it with
`pnpm add @modelcontextprotocol/sdk` to use this feature.
