---
'@livekit/agents': patch
---

Turn event loop stack sampling off by default. Taking a sample pauses the loop thread through the inspector, and on Node before 26.10 a pause can abort the process with a V8 CHECK in `JSInliner::ReduceJSCall` (`inlineability == SharedFunctionInfo::kHasOptimizationDisabled`). Set `LIVEKIT_AGENTS_LOOP_BLOCK_STACKS=adaptive` or `=1` to turn sampling on.
