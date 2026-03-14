# CLAUDE.md

LLM integration: chat context management, tool/function calling, provider format adapters, and realtime model abstractions.

## Key Classes

- **ChatContext** — Ordered container of `ChatItem` (ChatMessage | FunctionCall | FunctionCallOutput | AgentHandoffItem). Items sorted by `createdAt` timestamp, enabling out-of-order insertion.
- **ChatMessage** — Single message with polymorphic content (string, ImageContent, AudioContent). Role: 'developer' | 'system' | 'user' | 'assistant'.
- **FunctionCall / FunctionCallOutput** — Tool invocation and result, matched by `callId`. FunctionCall has `groupId` for parallel calls and `thoughtSignature` for Gemini thinking mode.
- **ReadonlyChatContext** — Immutable wrapper that throws on mutation. Used in callbacks.
- **LLM / LLMStream** — Abstract base classes for all LLM plugins. LLMStream handles retry with exponential backoff and metrics (TTFT, token counts).
- **RealtimeModel / RealtimeSession** — Abstractions for streaming/realtime APIs (e.g., OpenAI Realtime).

## Tool System (`tool_context.ts`)

- `tool({ description, parameters, execute })` — Factory function. Parameters accept Zod v3, Zod v4, or raw JSON Schema.
- `handoff({ agent, returns })` — Return from tool to transfer to another agent.
- **Symbol-based type markers**: Tools use private symbols (`TOOL_SYMBOL`, `FUNCTION_TOOL_SYMBOL`, etc.) for runtime discrimination — prevents spoofing.
- **ToolOptions**: Tools receive `{ ctx: RunContext<UserData>, toolCallId, abortSignal }`.

## Provider Format Adapters (`provider_format/`)

Three formats: `'openai'`, `'openai.responses'`, `'google'`.

- **`groupToolCalls()`** — Core algorithm shared by all adapters. Groups assistant messages with their tool calls and outputs by ID/groupId.
- **OpenAI**: Standard chat completions format with `tool_calls` array and `tool` role responses.
- **Google**: Turn-based with parts array. System messages extracted separately. Injects dummy user message (`.`) if last turn isn't user (Gemini requirement). Preserves `thoughtSignature` for thinking-mode models.
- **Image caching**: `ImageContent._cache` stores serialized versions to avoid re-encoding across provider conversions.

## Non-Obvious Patterns

- **Chronological insertion**: `ChatContext` maintains sorted order by `createdAt`. Late-arriving items (e.g., streamed chunks with timestamps) are inserted in correct position.
- **LCS-based diff**: `computeChatCtxDiff()` uses longest common subsequence for minimal create/remove operations — used by `RemoteChatContext` for IPC sync.
- **RemoteChatContext**: Linked-list based context for incremental updates. Insert by previous item ID, convert back via `toChatCtx()`.
- **Zod dual-version**: `zod-utils.ts` auto-detects Zod v3 (`_def.typeName`) vs v4 (`_zod` property) and routes schema conversion accordingly.
- **FallbackAdapter**: Multi-LLM failover with availability tracking, recovery tasks, and `availability_changed` events.
