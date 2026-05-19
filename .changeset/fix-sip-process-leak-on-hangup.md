---
'@livekit/agents': patch
---

fix(agents): shut down the job when the primary AgentSession closes on
participant disconnect

When the remote participant disconnects (especially common with SIP
hangups), `room_io` closes the primary `AgentSession` via
`closeOnDisconnect`. Previously nothing bridged that `Close` event back to
the `JobContext`, so the job process kept running until the parent
worker SIGTERMed it ~60s later, leaking one node process per hung-up
call.

The primary AgentSession now installs a one-shot `Close` listener that
calls `JobContext.shutdown('primary_session_closed')` when the close
reason is `PARTICIPANT_DISCONNECTED`. Other close reasons
(`USER_INITIATED`, `JOB_SHUTDOWN`, `ERROR`) are unchanged, so user code
that manually calls `session.close()` to start a new session continues
to keep the job alive.

Closes #927.
