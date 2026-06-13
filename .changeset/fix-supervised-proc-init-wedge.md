---
'@livekit/agents': patch
---

Fix `ProcPool` wedging permanently when a warming child process dies or
hangs before its first IPC message.

`SupervisedProc.initialize()` only completed via
`await once(proc, 'message')`, which never settled when the child exited
or crashed mid-prewarm (kernel OOM, V8 heap abort, import crash). The
init timeout rejected the side `init` future but left `initialize()`
itself pending, so `ProcPool.procWatchTask` was parked at
`await proc.initialize()` holding both `initMutex` and its `procMutex`
slot — the worker kept reporting available and accepting jobs that could
never launch.

`initialize()` now races three signals — first message, child `exit`,
and the init timeout — and kills the child on timeout. Late race losers
swallow their own rejection so a normal child exit after a successful
init never surfaces as an unhandled rejection. The pool's
`procWatchTask` already catches initialization failures, so its mutex
slots release and the pool replenishes as intended.
