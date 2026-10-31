---
'@livekit/agents': patch
---

While the worker reconnects, its messages to the server wait in a queue, as in the Python SDK, and go out once the new connection registers. Before, the worker dropped them. Load updates and pings are not kept.
