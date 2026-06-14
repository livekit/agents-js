---
"@livekit/agents": patch
---

fix(voice): propagate job context into tool execute on Node 24

Re-establish `jobContextStorage` inside the per-tool `Task.from()` body in
`performToolExecutions` so `getJobContext()` works from a tool's `execute()`
function on Node 24. Node 24's default `AsyncContextFrame` `AsyncLocalStorage`
implementation does not propagate the job context across the `Task.from()`
boundary the way the legacy `async_hooks` implementation did, which previously
caused `getJobContext()` to throw "no job context found" inside tools (#1255).
