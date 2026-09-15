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

`@modelcontextprotocol/sdk` is an optional peer dependency: install it with
`pnpm add @modelcontextprotocol/sdk` to use this feature.
