---
"@livekit/agents": minor
---

**BREAKING**: `Agent({ tools })` now accepts a list `(FunctionTool | ProviderDefinedTool | Toolset)[]` instead of a `Record<string, FunctionTool>` map. `llm.tool({ ... })` now requires a `name` field. `ToolContext` is a class (Python-parity) with `functionTools`/`providerTools`/`toolsets` accessors, `flatten()`, `getFunctionTool(name)`, `updateTools()`, `copy()`, and `equals()`. `agent.updateTools()` takes the same list. `Toolset` is exported as a stateful container with `id`, `tools`, and `setup()`/`aclose()` lifecycle hooks.
