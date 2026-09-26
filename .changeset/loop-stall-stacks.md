---
'@livekit/agents': patch
---

Event loop stalls now nest under the span that was running when the loop blocked (`function_tool`, `rpc_handler`, `on_user_turn_completed`, ...) and carry `lk.blocking.stack`, the loop thread's call stack sampled by the monitor's watchdog thread through an inspector session (at the warn threshold and again at ten times it). Sampling starts after a process's first stall, or from the start with `LIVEKIT_AGENTS_LOOP_BLOCK_STACKS=1`, never with `0`; it costs a one-time enumeration of the loaded scripts on the loop when it starts and about 1% of throughput afterwards. Not enabled while an inspector is attached to the process.
