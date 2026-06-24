---
'@livekit/agents': patch
---

Isolate the `withMockTools` test utility per async context. The active mock registry now lives in an `AsyncLocalStorage` instead of a module-level mutable global, so overlapping/concurrent tests no longer clobber each other's mock maps. This matches Python's per-async-context `ContextVar`. The public `using withMockTools(...)` Disposable API is unchanged.
