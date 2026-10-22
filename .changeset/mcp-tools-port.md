---
'@livekit/agents': patch
---

feat(mcp): add MCP (Model Context Protocol) server integration

Tools exposed by an MCP server are fetched by `MCPToolset` during activation.
Both stdio and HTTP transports (SSE + streamable HTTP) are supported.

```ts
const tools = [
  new llm.MCPToolset({
    id: 'mcp',
    mcpServer: new llm.MCPServerHTTP({ url: 'https://docs.livekit.io/mcp/' }),
  }),
];
```

HTTP transports require TLS by default. Set `allowInsecureHttp: true` only when connecting to a
trusted local development server.

`@modelcontextprotocol/client` (2.3.1 or newer, Node.js 20+) is an optional peer dependency:
install it with `pnpm add @modelcontextprotocol/client` to use this feature.

Protocol auto-negotiation supports the stateless MCP 2026-07-28 protocol and older servers.
Stateless HTTP servers can return JSON responses without sessions, notifications, or persistent
connections. Set `transportType: 'streamable_http'` explicitly for endpoints that do not end in `/mcp`.
