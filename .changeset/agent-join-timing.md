---
'@livekit/agents': patch
---

Report job status to the server, as the Python SDK does: running when a process takes the job, running with the join instants once the agent connects, and success or failure when the process exits. Before, the server learned that a job ended only when the agent left the room or the worker disconnected. The join instants are readings of the host's monotonic clock at each step from the job offer to the room connection.

While the worker reconnects, its messages to the server wait in a queue, as in the Python SDK, and go out once the new connection registers. Load updates and pings are not kept.
