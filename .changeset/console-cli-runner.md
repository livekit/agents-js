---
'@livekit/agents': patch
---

Add a `console` CLI subcommand and in-process console runner, the final piece that lets a local broker (e.g. the LiveKit CLI `lk session` daemon) drive a Node agent over TCP. `runConsole` loads the agent, opens a `TcpSessionTransport` to `--connect-addr`, sets up an `AgentsConsole` singleton, and runs the agent entrypoint in-process (mirroring python's `_run_tcp_console`, which uses `JobExecutorType.THREAD` to share the console singleton with the `AgentSession`). `AgentSession` now wires its `SessionHost` from the `AgentsConsole` singleton when console mode is active, and `JobContext` gained fake-job support (`isFakeJob`, no-op `connect`/`deleteRoom`/recording) so a console job without a backing LiveKit room behaves correctly. Audio IO is attached by default (voice mode); a text-mode driver disables it at runtime via an `update_io` request.
