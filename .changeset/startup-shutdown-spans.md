---
'@livekit/agents': patch
---

Trace the job's dispatch timeline, startup and shutdown: `job_entrypoint` now spans the whole job with the dispatch stages as events and latencies, `agent_session` nests under it with `session_start`/`session_close` grouping the startup and teardown work (`room_connect`, `wait_for_participant`, `wait_for_audio_track`, `publish_audio_output`, `setup_toolsets`, `drain_agent_activity`), `job_shutdown` groups the shutdown sequence, and the cloud trace pipeline is prepared at job start so the first job's early spans record.
