---
'@livekit/agents': minor
---

**BREAKING**: `Agent({ tools })` and `agent.updateTools()` now accept a flat list `(FunctionTool | ProviderTool | Toolset)[]` instead of a `Record<string, FunctionTool>` map, and `llm.tool({ ... })` requires a `name` field. `ToolContext` is now a Python-parity class with `functionTools` / `providerTools` / `toolsets` accessors, plus `flatten()`, `hasTool(id)`, `getFunctionTool(id)`, `updateTools()`, `copy()`, and `equals()`. To match the Python reference, registering two **different** function-tool instances under the same `name` now throws `duplicate function name: <name>` instead of silently overriding the earlier entry; passing the **same instance** twice is a no-op. `agent.toolCtx` returns a defensive copy so callers can no longer mutate the agent's internal state. `LLM.chat({ toolCtx })` accepts either a `ToolContext` instance or a raw `(FunctionTool | ProviderTool | Toolset)[]` array (`ToolCtxInput`) and normalizes it internally, so callers don't have to construct a `ToolContext` themselves.

Tools also expose an `id: string` field on the base `Tool` interface (parity with Python's `Tool.id` property): for `FunctionTool` it mirrors `name`, for `ProviderTool` it is the provider tool id. `ToolContext` keys and equality now use `tool.id` consistently.

**BREAKING**: Provider tools are now modeled to match Python's `ProviderTool`:

- `ProviderDefinedTool` is renamed to `ProviderTool`, and `isProviderDefinedTool` is renamed to `isProviderTool`.
- `ProviderTool` is now an **abstract class** (Python parity). Plugins must subclass it (`class WebSearch extends ProviderTool { ... }`) to attach provider-specific fields and serializers; bare `new ProviderTool(...)` is rejected at compile time.
- The `tool({ id })` factory overload is removed; `tool({ ... })` only creates function tools now. Construct provider tools by instantiating a `ProviderTool` subclass.
- The `ToolType` literal for provider tools is renamed from `'provider-defined'` to `'provider'`.

`Toolset` now carries a `TOOLSET_SYMBOL` marker and is detected via a new `isToolset()` guard (consistent with `isFunctionTool` / `isProviderTool`). Existing `instanceof Toolset` checks still work, but symbol-based detection is preferred for cross-realm safety.
