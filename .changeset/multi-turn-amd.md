---
'@livekit/agents': patch
---

Replace the one-shot answering-machine detection (AMD) with multi-turn AMD, ported from livekit/agents#6202.

AMD now classifies each committed user turn through call screening, voicemail, and IVR stages until it completes. `execute()` returns an `AMDCompletedEvent` (`category`, `reason`, `voicemailMessagePlayed`, `lastPrediction`) instead of the first prediction. Start AMD with `await amd.start()` and close it with `await amd.aclose()`. The `amd_prediction` event fires for each turn, and the new `amd_completed` and `amd_menu_observed` events report completion and observed IVR menus. AMD holds machine replies until the participant is silent, adds stage instructions to replies, gives IVR replies the DTMF tool, and tracks voicemail playout. Set `screeningInstructions`, `voicemailInstructions`, or `ivrInstructions` to `null` to complete AMD without a reply when the call enters that stage, for example to hang up at the first voicemail prediction. `humanInstructions: null` keeps the Agent's own instructions. The `llm` option also accepts a `DecisionModel` that supports `choice` decisions; it classifies each turn with one choice, and AMD then skips IVR menu extraction.

Remote sessions get screening and wait as their own AMD categories, each prediction's turn ID, stage, and inference duration, and a new `amd_completed` event with the run's result. This requires `@livekit/protocol` 1.53.3 or later.

`AgentSession` gains internal turn hooks that AMD uses to observe committed turns and control their replies. `UserStateChangedEvent` gains `speechTimestamp`, and `FunctionToolsExecutedEvent` gains `hasAgentHandoff` and `cancelAgentHandoff()`. Agent handoffs throw while AMD runs. `sendDtmfEvents` returns a `ToolResult` that requests no follow-up reply and throws a `ToolError` without provider text when a publish fails. A realtime reply's tool follow-up keeps its instructions and tools, and the agent returns to `listening` when no tool reply follows. Realtime failure logs carry only the error type. A closed `LLMStream` no longer retries.
