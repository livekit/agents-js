# @livekit/agents

## 1.5.6

### Patch Changes

- Expose realtime provider response IDs on assistant message metrics as `providerRequestIds`. - [#2084](https://github.com/livekit/agents-js/pull/2084) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add Fish Audio model and option types to inference TTS. - [#2102](https://github.com/livekit/agents-js/pull/2102) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Support adaptive interruption gating for realtime models without server-side turn detection. - [#2099](https://github.com/livekit/agents-js/pull/2099) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add `inference.AvatarSession` for provisioning avatar sessions through the LiveKit Inference gateway. - [#2101](https://github.com/livekit/agents-js/pull/2101) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Do not drop realtime replies when the pre-reply chat context update times out. - [#2083](https://github.com/livekit/agents-js/pull/2083) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Fix updateAgent handoffs so run() captures onEnter output without waiting indefinitely on long-lived onEnter flows. - [#2098](https://github.com/livekit/agents-js/pull/2098) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

## 1.5.5

### Patch Changes

- Default AMD to wait for endpointing backstop before settling after speech. - [#2089](https://github.com/livekit/agents-js/pull/2089) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Prevent interrupted voice replies from deadlocking when audio recording wraps synchronized playout. - [#2091](https://github.com/livekit/agents-js/pull/2091) ([@toubatbrian](https://github.com/toubatbrian))

- Add raw chat message text access and strip LiveKit expression markup from assistant text content. - [#2087](https://github.com/livekit/agents-js/pull/2087) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Preserve custom OpenTelemetry tracer providers when LiveKit Cloud tracing is enabled, and support sharing an OpenTelemetry 2.x provider with LiveKit Cloud via the `registerSpanProcessor` and `createCloudSpanProcessor` options of `setTracerProvider` together with the new `FanoutSpanProcessor` helper. - [#2051](https://github.com/livekit/agents-js/pull/2051) ([@dtran26](https://github.com/dtran26))

- Prevent in-flight tool calls from being re-issued on later turns and preserve completed tool outputs when a turn is interrupted. - [#2077](https://github.com/livekit/agents-js/pull/2077) ([@toubatbrian](https://github.com/toubatbrian))

- fix(stt): propagate fallback stream start offset - [#1928](https://github.com/livekit/agents-js/pull/1928) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add job, simulation, and redaction telemetry metadata to session recording uploads. - [#2079](https://github.com/livekit/agents-js/pull/2079) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

## 1.5.4

### Patch Changes

- Skip warning when avatar participant removal finds no participant in the room. - [#2072](https://github.com/livekit/agents-js/pull/2072) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- End uncommitted `user_turn` spans when audio recognition closes so speech detected without a transcript is still exported to observability. - [#2062](https://github.com/livekit/agents-js/pull/2062) ([@chenghao-mou](https://github.com/chenghao-mou))

- Keep dynamic endpointing maxDelay fixed while learning minDelay. - [#2073](https://github.com/livekit/agents-js/pull/2073) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Include function names in remote session function call output protos. - [#2078](https://github.com/livekit/agents-js/pull/2078) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Reset the user-away timer when a final STT transcript arrives while the user and agent are listening. - [#2063](https://github.com/livekit/agents-js/pull/2063) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Respect `outputOptions.audioPublishOptions` when publishing the agent's audio track. `ParticipantAudioOutput.publishTrack()` previously ignored the configured `trackPublishOptions` and always published with hardcoded defaults, making it impossible to disable DTX/RED on the output track. - [#2076](https://github.com/livekit/agents-js/pull/2076) ([@adaro](https://github.com/adaro))

- Strip Gemma reasoning markers from streamed inference output. - [#2071](https://github.com/livekit/agents-js/pull/2071) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add an optional `roomName` option to `WarmTransferTask`, allowing the human-agent briefing room to be pre-created with custom configuration (e.g. an egress request to record the transfer leg) before the task dials the human agent. - [#2056](https://github.com/livekit/agents-js/pull/2056) ([@toubatbrian](https://github.com/toubatbrian))

## 1.5.3

### Patch Changes

- Export the `AudioInput` base class from the `voice` module so plugins and applications can implement custom agent audio inputs. - [#2036](https://github.com/livekit/agents-js/pull/2036) ([@aweitz](https://github.com/aweitz))

- Commit the in-flight assistant turn (interrupted: true, partially-forwarded text) when the session closes mid-playout — previously a room disconnect during playback dropped the turn from chatCtx entirely, with no ConversationItemAdded emitted (#2041) - [#2042](https://github.com/livekit/agents-js/pull/2042) ([@Sarfaraz85](https://github.com/Sarfaraz85))

- Restart chunked TTS retries with a fresh attempt queue so retried synthesis uses a fresh request ID and does not write to a closed failed-attempt queue. - [#1994](https://github.com/livekit/agents-js/pull/1994) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Honor `ToolFlag.IGNORE_ON_ENTER` for tools nested inside `Toolset`s. - [#2011](https://github.com/livekit/agents-js/pull/2011) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Fix modality-aware instruction templates to collapse identical variants and avoid duplicate rendered output. - [#2030](https://github.com/livekit/agents-js/pull/2030) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(voice): stop dropping agent turns whose playback starts after audio forwarding completes (#1909, #1960; port of livekit/agents#5039). - [#1966](https://github.com/livekit/agents-js/pull/1966) ([@toubatbrian](https://github.com/toubatbrian))

  `forwardAudio` used to reject `firstFrameFut` (and detach its `PLAYBACK_STARTED` listener) in its `finally` block whenever no frame had played by the time forwarding finished. Two real scenarios hit this window: a speech paused in the thinking state by a brief user sound, whose buffered first frame only plays after the false interruption clears (#1909), and DataStream avatar outputs with `waitPlaybackStart: true`, which deliver `lk.playback_started` ~1s after frames were captured (#1960). In both cases the late playback-started event found nothing listening, the reply was classified "skipped", and the turn was silently removed from the chat context while the agent never entered the `speaking` state.

  The `PLAYBACK_STARTED` listener now lives in `performAudioForwarding` so it outlives the forwarding task, and `forwardAudio` no longer settles the future; the reply tasks (including the `say()` path) settle it once the playout window ends, which also detaches the listener. A reported non-zero playback position on interruption is additionally honored as evidence of partial playback — but only when the segment actually captured a frame into the output (tracked via the output's segment count, which is also what makes the reported position fresh rather than stale) — covering avatars whose playback-started RPC races the interruption itself.

- Preserve partial LLM response telemetry and generated function calls on every inference exit path. - [#2048](https://github.com/livekit/agents-js/pull/2048) ([@toubatbrian](https://github.com/toubatbrian))

- fix(voice): stop RecorderIO from dropping the final agent speech at session teardown. A force-interrupted shutdown marks the current speech done before playout settles, so the recorder could close and fence out the in-flight playbackFinished flush, silently losing the last agent turn and trailing mic audio from the recording. RecorderIO.close() now waits (bounded) for the pending playback event — which carries the authoritative playback position — before fencing, flushes any input captured since the last write, and warns if unflushed agent audio had to be dropped. - [#2037](https://github.com/livekit/agents-js/pull/2037) ([@chenghao-mou](https://github.com/chenghao-mou))

- Deprecate the `nativeTranscriptSync` realtime model capability while preserving its existing transcript synchronization behavior for third-party models. Remove Phonic's redundant explicit opt-out now that it uses `stream_ahead_of_real_time` mode. - [#2044](https://github.com/livekit/agents-js/pull/2044) ([@tinalenguyen](https://github.com/tinalenguyen))

- Avoid splitting streamed replacement output mid-word when no replacement key prefix is pending. - [#2050](https://github.com/livekit/agents-js/pull/2050) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add a beta DTMF sending tool that publishes to the active agent session room. - [#2010](https://github.com/livekit/agents-js/pull/2010) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add `speed` to xAI TTS inference options. - [#2028](https://github.com/livekit/agents-js/pull/2028) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

## 1.5.2

## 1.5.1

### Patch Changes

- Replace @ffmpeg-installer/ffmpeg with @livekit/av, LiveKit's own minimal LGPL FFmpeg build shipped as platform-specific npm packages. - [#1999](https://github.com/livekit/agents-js/pull/1999) ([@u9g](https://github.com/u9g))

- Conversation-aware STT recognition (keyterms + chat context), ported from python livekit-agents PR #6039. Adds `keytermsOptions` on `AgentSession` with static `keyterms` and LLM-based `keytermDetection` (confirmation-gated), new `STTCapabilities.keyterms`/`chatContext` flags with `_updateSessionKeyterms()`/`_pushConversationItem()` hooks (forwarded by the fallback and stream adapters), keyterm support for deepgram (v1/v2), assemblyai, and livekit inference STT, and native conversation-context carryover (`agentContextCarryover`) for assemblyai u3-rt-pro. - [#1967](https://github.com/livekit/agents-js/pull/1967) ([@toubatbrian](https://github.com/toubatbrian))

- Disable OpenAI SDK retries for LiveKit inference and OpenAI SDK-based plugin requests. - [#1981](https://github.com/livekit/agents-js/pull/1981) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Export the `AnonFunctionTool` type so callers can annotate return types for name-less `tool()` factories used in object-map tool registration. - [#2014](https://github.com/livekit/agents-js/pull/2014) ([@jonh-1](https://github.com/jonh-1))

- Fix duplicated user chat items in observability: a superseding EOU bounce created while an earlier bounce was mid-commit could fire after the transcript was already committed and cleared, committing a second empty user turn with stale metrics. The transcript guard is now re-checked at fire time. Also, session-report chat items now only upload string content (matching Python), so non-string content can no longer render as garbage in the dashboard. - [#1955](https://github.com/livekit/agents-js/pull/1955) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Fix TTS TTFB attribution: `tts_node` TTFB is now anchored on the time the first sentence is sent to the TTS provider instead of the time the first LLM token arrives, so upstream text generation and tokenization latency is no longer counted as TTS latency. - [#1955](https://github.com/livekit/agents-js/pull/1955) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Fix `session.run()` stalling or racing the activity transition when an AgentTask handoff is triggered by a speech that predates the run (e.g. created in `onEnter`): the blocked handoff tasks are now watched by the active run for the duration of the transition. - [#1961](https://github.com/livekit/agents-js/pull/1961) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add output retries for AgentSession.run structured outputs. - [#1978](https://github.com/livekit/agents-js/pull/1978) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- implement CLI serverInfo protocol - [#2015](https://github.com/livekit/agents-js/pull/2015) ([@davidzhao](https://github.com/davidzhao))

- Tighten audio EOT cancellation to rely on speech activity start events. - [#1939](https://github.com/livekit/agents-js/pull/1939) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Trim the chat context recorded on the `eou_detection` span to the last 6 items and exclude function calls, instructions, empty messages, handoffs, and config updates (matching Python), so the span no longer re-emits the whole conversation on every end-of-turn inference. - [#1955](https://github.com/livekit/agents-js/pull/1955) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- chore(deps): update @livekit/rtc-node to 0.13.31 - [#1992](https://github.com/livekit/agents-js/pull/1992) ([@toubatbrian](https://github.com/toubatbrian))

  Fixes AudioSource.waitForPlayout resolving early with audio still queued (livekit/node-sdks#693).

- fix(workflows): cancel a warm transfer when the caller hangs up before the merge. `WarmTransferTask` now watches the caller room from `onEnter`: if the caller disconnects while the human agent's phone is still ringing or during the briefing, the pending SIP dial is aborted, the human agent room is torn down (ending the call), and the task completes with a `ToolError` — instead of the human agent being connected into an empty room. A human agent who already answered is told the caller left — a reply generated from the new `callerHangupInstruction` option (built-in default when not provided) — before their call is ended. - [#2008](https://github.com/livekit/agents-js/pull/2008) ([@toubatbrian](https://github.com/toubatbrian))

- chore(example): update otel trace example - [#1864](https://github.com/livekit/agents-js/pull/1864) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

## 1.5.0

### Minor Changes

- Port async tool execution semantics from Python: tools can release their turn with `ctx.update()`, - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))
  `AsyncToolset` controls session/activity scope, and cancellable tools expose task-management helpers.

- **BREAKING**: `Agent({ tools })` and `agent.updateTools()` now accept a flat list `(FunctionTool | ProviderTool | Toolset)[]` instead of a `Record<string, FunctionTool>` map, and `llm.tool({ ... })` requires a `name` field. `ToolContext` is now a Python-parity class with `functionTools` / `providerTools` / `toolsets` accessors, plus `flatten()`, `hasTool(id)`, `getFunctionTool(id)`, `updateTools()`, `copy()`, and `equals()`. To match the Python reference, registering two **different** function-tool instances under the same `name` now throws `duplicate function name: <name>` instead of silently overriding the earlier entry; passing the **same instance** twice is a no-op. `agent.toolCtx` returns a defensive copy so callers can no longer mutate the agent's internal state. `LLM.chat({ toolCtx })` accepts either a `ToolContext` instance or a raw `(FunctionTool | ProviderTool | Toolset)[]` array (`ToolCtxInput`) and normalizes it internally, so callers don't have to construct a `ToolContext` themselves. - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

  Tools also expose an `id: string` field on the base `Tool` interface (parity with Python's `Tool.id` property): for `FunctionTool` it mirrors `name`, for `ProviderTool` it is the provider tool id. `ToolContext` keys and equality now use `tool.id` consistently.

  **BREAKING**: Provider tools are now modeled to match Python's `ProviderTool`:

  - `ProviderDefinedTool` is renamed to `ProviderTool`, and `isProviderDefinedTool` is renamed to `isProviderTool`.
  - `ProviderTool` is now an **abstract class** (Python parity). Plugins must subclass it (`class WebSearch extends ProviderTool { ... }`) to attach provider-specific fields and serializers; bare `new ProviderTool(...)` is rejected at compile time.
  - The `tool({ id })` factory overload is removed; `tool({ ... })` only creates function tools now. Construct provider tools by instantiating a `ProviderTool` subclass.
  - The `ToolType` literal for provider tools is renamed from `'provider-defined'` to `'provider'`.

  `Toolset` now carries a `TOOLSET_SYMBOL` marker and is detected via a new `isToolset()` guard (consistent with `isFunctionTool` / `isProviderTool`). Existing `instanceof Toolset` checks still work, but symbol-based detection is preferred for cross-realm safety.

- Add beta EndCallTool for ending calls from agent tools - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- Promote the `TaskGroup` workflow out of beta. It now lives in the stable `workflows` namespace — import it as `workflows.TaskGroup` (with `workflows.TaskCompletedEvent`, `workflows.TaskGroupOptions`, and `workflows.TaskGroupResult`) instead of `beta.TaskGroup`. The `beta` namespace continues to re-export these symbols as deprecated aliases for backward compatibility; they will be removed in a future release. This is an intentional Node.js-only change; in Python `TaskGroup` remains under `beta.workflows`. - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- Promote the `WarmTransferTask` workflow out of beta. It now lives in the stable `workflows` namespace — import it as `workflows.WarmTransferTask` (with `workflows.WarmTransferResult`, `workflows.WarmTransferTaskOptions`, and `workflows.InstructionParts`) instead of `beta.WarmTransferTask`. The `beta` namespace continues to re-export these symbols as deprecated aliases for backward compatibility; they will be removed in a future release. - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

### Patch Changes

- Add `Agent.updateInstructions()` to update an agent's instructions mid-session (parity with Python). The change propagates the new instructions through the active `AgentActivity`, records an `AgentConfigUpdate` in the chat and session history, and syncs the realtime/stateless contexts. For OpenAI realtime, per-response instructions now preserve the session-level instructions instead of replacing them. - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- Adaptive interruption detection now omits the threshold from `session.create` unless the user explicitly overrides it, letting the gateway apply its fetched default (surfaced via `default_threshold` on `session.created`). The HTTP transport has been dropped — detection always connects over WebSocket and always requires LiveKit credentials, and its base URL now defaults from `LIVEKIT_INFERENCE_URL` instead of `LIVEKIT_REMOTE_EOT_URL`. Inference requests also send an `X-LiveKit-Worker-Token` header when `LIVEKIT_WORKER_TOKEN` is set (hosted agents); a token supplied via the `--worker-token` CLI flag is now re-exported into the environment so forked job subprocesses inherit it and include the header. The `X-LiveKit-Agent-Id` header is now only attached once the room is connected to avoid leaking an unset local-participant SID. The interruption WebSocket is now closed deterministically on stream teardown (including error and cancel paths) instead of only on graceful completion — previously an orphaned socket leaked per session/activity and accumulated for the worker's lifetime. Mid-session threshold/duration changes via `updateOptions` now reconnect the WebSocket in place rather than closing it and letting the next send error the stream — so option changes no longer consume a failover retry (previously enough updates in a session could exhaust the retry budget and stop interruption detection). - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- Add Agent.create method - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- Add scoped filler support to RunContext - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- Don't retain recorded events when recording is disabled - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- Add Inworld `delivery_mode` to inference TTS model options. - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- List available tools in unknown-function error output. - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- Add `LLMStream.collect()` for awaiting the full response of a chat stream as a single object (text, tool calls, usage, extra). - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- feat(testing): add `mockTools` utility to override an Agent's tool implementations within an async context, mirroring the Python `mock_tools` API - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- Add object-map tool syntax compatibility. - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- Fix interrupted assistant speech being dropped from chat history when the audio output provides no playback-aligned transcript. On a mid-playout interruption, `forwardedTextFor` (and the realtime reply path) returned `synchronizedTranscript ?? ''`, so an interrupted-but-heard reply produced no `conversation_item_added` and was missing from `chatCtx` — common with avatar outputs that don't emit a synchronized transcript. The commit now falls back to the forwarded generation text (`textOut.text`), matching the Python SDK's `_ForwardOutput.forwarded_text` behavior. - [#1916](https://github.com/livekit/agents-js/pull/1916) ([@ShayneP](https://github.com/ShayneP))

- Adds base `Toolset` support: a stateful container for a group of tools with `setup()` / `aclose()` lifecycle hooks. Toolsets can be passed directly into `Agent({ tools: [...] })` alongside individual function tools; their tools are flattened into the agent's `ToolContext` and the runtime drives `setup()` on activity start, `aclose()` on close, and a setup/close diff when `agent.updateTools()` adds or removes Toolsets mid-session. Per-toolset `setup()` errors are logged but do not abort the activity. The `IGNORE_ON_ENTER` flag is also respected for function tools nested inside a Toolset. Every LLM and realtime plugin tool builder iterates `ToolContext.flatten()` so toolset-contributed tools are correctly advertised. Also exports `ToolCalledEvent` / `ToolCompletedEvent` payload types. - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- fix(voice): scope forwardAudio's playback-started listener to its own segment - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

  When a speech is interrupted, the scheduling loop immediately authorizes the next
  speech, so the new segment's `forwardAudio` registers its `playback_started`
  listener on the shared audio output while the interrupted segment is still
  emitting events during teardown. The stray event resolved the new segment's
  `firstFrameFut` before its first frame was captured, which skipped resampler
  creation and pushed an unresampled frame straight to the `AudioSource`
  (`RtcError: sample_rate and num_channels don't match`) and corrupted playback
  bookkeeping. The listener now only resolves `firstFrameFut` after the segment has
  captured its own first frame.

- chore(deps): update livekit dependency - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- Increase the default worker drain timeout to one hour. - [#1930](https://github.com/livekit/agents-js/pull/1930) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(eot): disable retries for eot connections and errors - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- Pipeline nodes (`ttsNode`, `sttNode`, `transcriptionNode`, `realtimeAudioOutputNode`) now accept an async generator/iterable as their stream input end-to-end. This includes the static `Agent.default.*` helpers and the `Agent.create()` / `AgentTask.create()` hook overrides, so overrides can pass a generator directly to `voice.Agent.default.<node>(ctx.agent, generator, settings)` without wrapping it in `toStream()` first. Also fixes a `getReader is not a function` crash when an `Agent.create`/`AgentTask.create` stream hook received a plain `AsyncIterable`. - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

- fix(warm-transfer): capture job context for post-merge caller-room cleanup - [#1674](https://github.com/livekit/agents-js/pull/1674) ([@toubatbrian](https://github.com/toubatbrian))

  `WarmTransferTask`'s post-merge `RoomEvent.ParticipantDisconnected` listener called `getJobContext()` to build a `RoomServiceClient` and delete the caller room. That handler runs from a native rtc-node FFI callback whose `AsyncLocalStorage` context is pinned to `FfiClient`-singleton creation, not to the job's context — so `getJobContext()` read an empty (or stale) store and threw, surfacing as an unhandled promise rejection and leaving the 2-party SIP room undeleted when a participant hung up after the bridge. The task now captures the `JobContext` eagerly in `onEnter()` (while the live context is available) and uses `jobCtx.deleteRoom()` in the late handler, which also passes the job's API credentials instead of relying on environment variables.

## 1.4.11

## 1.4.10

### Patch Changes

- Add Deepgram `keyterm` to inference STT model options and support batch recognition in the Deepgram STT plugin. - [#1766](https://github.com/livekit/agents-js/pull/1766) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(llm): log silent error from performLLMInference - [#1880](https://github.com/livekit/agents-js/pull/1880) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Preserve realtime transcription item IDs on user input transcription events. - [#1902](https://github.com/livekit/agents-js/pull/1902) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- chore(dep): update local-inference dep - [#1873](https://github.com/livekit/agents-js/pull/1873) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Simulation fixes: do not start the worker HTTP server, disable the worker load limit so runs can saturate the agent, and honor `LIVEKIT_AGENT_NAME_OVERRIDE` so the worker registers under the name `lk simulate` dispatches to. - [#1804](https://github.com/livekit/agents-js/pull/1804) ([@u9g](https://github.com/u9g))

- Emit the `lk.chat_ctx` span attribute (on LLM-generation and EOU-prediction spans) in snake_case to match the Python framework, which serializes the same attribute via `chat_ctx.to_dict()`. The JS side was stringifying `chatCtx.toJSON()` directly, which emits camelCase field names (`callId`, `args`, `isError`, `createdAt`), so traces from JS agents diverged from Python agents. The chat context is now run through the shared `toSnakeCaseDeep` conversion (exported from the report layer), and the timestamp exclusion is aligned with Python (`toJSON()` defaults exclude image/audio/timestamps). Note: the Python EOU path additionally trims to the last N turns and excludes function calls — aligning that behavior is left to a follow-up. - [#1804](https://github.com/livekit/agents-js/pull/1804) ([@u9g](https://github.com/u9g))

- Serialize chat-item `toJSON()` output in snake_case (e.g. `new_agent_id`, `call_id`, `arguments`, `is_error`, `created_at`) to match the Python session-report schema. The uploaded `chat_history.json` previously used camelCase keys, so LiveKit Cloud's parser rejected required fields (e.g. `agent_handoff.new_agent_id`). Constructor/`create()` APIs are unchanged. - [#1804](https://github.com/livekit/agents-js/pull/1804) ([@u9g](https://github.com/u9g))

- Serialize the session report's `events` and `usage` arrays in snake_case to match the Python session-report schema. Event fields (`old_state`, `new_state`, `is_final`, `speaker_id`, `function_calls`, `created_at`, …) and model-usage fields (`input_tokens`, `session_duration`, `audio_duration`, `characters_count`, `total_requests`, …) previously leaked camelCase keys, so LiveKit Cloud's Python parser dropped them. Usage durations are now emitted in seconds (matching the proto wire format and Python model). Also adds the `audio_recording_path`, `audio_recording_started_at`, `sdk_version`, and `options.user_away_timeout` fields to match Python's `SessionReport.to_dict()`. - [#1804](https://github.com/livekit/agents-js/pull/1804) ([@u9g](https://github.com/u9g))

- Serialize the uploaded session-recording `chat_history` in snake_case to match the Python wire schema. `uploadSessionReport` was stringifying `chatHistory.toJSON()` directly, which emits camelCase field names; the snake_case conversion lives only in `sessionReportToJSON` (`toSnakeCaseDeep`). As a result the uploaded chat history carried camelCase keys (`callId`, `args`, `isError`, `newAgentId`, `createdAt`), and the Python consumer's pydantic validation rejected the chat items with "field required" errors for `call_id`, `arguments`, `is_error`, and `new_agent_id`. The upload now reuses `sessionReportToJSON(report).chat_history` so the two serializations can't drift. - [#1804](https://github.com/livekit/agents-js/pull/1804) ([@u9g](https://github.com/u9g))

- Keep the STT input timestamp anchor attached to reused STT pipelines across agent handoff. - [#1870](https://github.com/livekit/agents-js/pull/1870) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

## 1.4.9

### Patch Changes

- Add AssemblyAI inference STT parameters for agent context, Voice Focus, Voice Focus threshold, and streaming mode. - [#1852](https://github.com/livekit/agents-js/pull/1852) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(eot): restore inference prediction timeout - [#1853](https://github.com/livekit/agents-js/pull/1853) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Sanitize turn detector for session reports: the OTLP attribute serializer now honors `toJSON()`, and the audio turn detector exposes a credential-free config snapshot. - [#1847](https://github.com/livekit/agents-js/pull/1847) ([@chenghao-mou](https://github.com/chenghao-mou))

## 1.4.8

### Patch Changes

- Add `assemblyai/universal-3-5-pro` to the inference STT model type hints. - [#1840](https://github.com/livekit/agents-js/pull/1840) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

## 1.4.7

### Patch Changes

- feat(core): audio end-of-turn detection with cloud → local fallback (AGT-2520) - [#1719](https://github.com/livekit/agents-js/pull/1719) ([@chenghao-mou](https://github.com/chenghao-mou))

  - New `inference.TurnDetector`: WebSocket cloud EOT transport (`version: 'v1'`, model name `turn-detector-v1`) with automatic fallback to the local native model (`version: 'v1-mini'`, model name `turn-detector-v1-mini`) via `@livekit/local-inference`. Auto-selects `'v1'` when `LIVEKIT_REMOTE_EOT_URL` is set, `'v1-mini'` otherwise. The `version` is the constructor knob; telemetry/billing report the full model name via `detector.model`.
  - The local EOT model runs in the shared inference process (the same `InferenceProcExecutor` the text turn detector uses), loaded once per worker host (~138 MB) instead of in every job worker. The runner is registered by default when the native binding is available, so the inference process spawns on worker startup; on platforms where the binding can't load, local EOT degrades to a positive-default prediction and the worker still starts. (This is a JS-specific divergence from Python, which keeps EOT in-process and relies on forkserver COW sharing.)
  - No prewarm helpers: EOT auto-warms in the inference process; the in-process silero VAD lazy-loads on first stream. (The `inference.prewarm*` helpers added during development were removed before release.)
  - New `inference.VAD` (local-only streaming VAD via `@livekit/local-inference`).
  - `AgentSession` now auto-provisions a bundled silero VAD when `vad` is omitted (`isDefault=true`). Pass `vad: null` to opt out.
  - `livekit-plugins-silero` is deprecated; pass `vad: null` to opt out of the bundled default, or use `inference.VAD({ model: 'silero', ... })` to customise.
  - `livekit-plugins-livekit` turn detector is deprecated in favor of `inference.TurnDetector`.
  - Endpointing defaults are now detector-aware: when the resolved turn detector is a streaming ("audio model") detector — the bundled default — unset endpointing keys fall back to tighter defaults (`minDelay: 300`, `maxDelay: 2500`) instead of the legacy `500`/`3000`. Non-streaming modes (`vad`/`stt`/`manual`/`realtime_llm`, or `turnDetection: null`) keep the legacy defaults. Explicit user keys are tracked as sparse overrides and re-resolved per agent activity, so different agents in one session can use different detectors and runtime `updateOptions` changes survive handoffs.
  - New `EOTInferenceMetrics` and `EOTModelUsage`; new telemetry span attributes (`lk.eou.source`, `lk.eou.from_cache`, `lk.eou.detection_delay`); new `eot_prediction` event forwarded over remote sessions.
  - Requires `@livekit/protocol` >= 1.46.5 (exposes the `AgentInference` message namespace used by the cloud transport, including the server-provided `SessionCreated` default thresholds).

- Add `TcpAudioInput`/`TcpAudioOutput` for console-mode sessions, porting the Python `tcp_console` audio IO: inbound `audio_input` frames are resampled from the 48 kHz wire rate to the 24 kHz agent rate and fed to the STT pipeline, while the agent's TTS frames are resampled back up and streamed as `audio_output` messages. The output drives the flush/clear playout handshake, blocking the agent turn until the broker reports `audio_playback_finished` (or reporting an interruption when the buffer is cleared). `SessionHost` now accepts optional audio IO and routes inbound `audio_input`/`audio_playback_finished` messages to it. - [#1694](https://github.com/livekit/agents-js/pull/1694) ([@toubatbrian](https://github.com/toubatbrian))

- Add a `console` CLI subcommand and in-process console runner, the final piece that lets a local broker (e.g. the LiveKit CLI `lk session` daemon) drive a Node agent over TCP. `runConsole` loads the agent, opens a `TcpSessionTransport` to `--connect-addr`, sets up an `AgentsConsole` singleton, and runs the agent entrypoint in-process (mirroring python's `_run_tcp_console`, which uses `JobExecutorType.THREAD` to share the console singleton with the `AgentSession`). `AgentSession` now wires its `SessionHost` from the `AgentsConsole` singleton when console mode is active, and `JobContext` gained fake-job support (`isFakeJob`, no-op `connect`/`deleteRoom`/recording) so a console job without a backing LiveKit room behaves correctly. Audio IO is attached by default (voice mode); a text-mode driver disables it at runtime via an `update_io` request. - [#1706](https://github.com/livekit/agents-js/pull/1706) ([@toubatbrian](https://github.com/toubatbrian))

- Console mode parity fixes for the `lk agent console` flow: run registered inference runners (e.g. the livekit turn detector) in a supervised child process instead of failing, and write `--record` output (`audio.ogg` + `session_report.json`) to a local `console-recordings/session-<timestamp>/` directory like python, instead of a temp dir with no report. - [#1706](https://github.com/livekit/agents-js/pull/1706) ([@toubatbrian](https://github.com/toubatbrian))

- feat(eot): emit agent backchannel opportunity events (AGT-2520) - [#1719](https://github.com/livekit/agents-js/pull/1719) ([@chenghao-mou](https://github.com/chenghao-mou))

  The multimodal EOT model now returns a backchannel probability alongside the end-of-turn probability. The turn detector compares it to a server-provided threshold and, when it clears, surfaces an internal backchannel _opportunity_ (a window where the agent could say a short "mm-hmm" while the user still holds the floor) to `AgentActivity`.

  - `inference.TurnDetector` gains a `backchannelThreshold` option (and `updateOptions({ backchannelThreshold })`); `ThresholdOptions.lookupBackchannel()` resolves server-provided defaults layered with user overrides, mirroring the existing EOT threshold resolution.
  - Backchannel thresholds are server-driven and cloud-only — disabled when the gateway sends none, after a cloud→local fallback (the mini model produces no backchannel probability), and for any non-positive threshold.
  - Internal only: `AgentActivity.onAgentBackchannelOpportunity` is a no-op with a TODO; the event is not surfaced as a public `AgentSession` event (absent from the `AgentEvent` union, `AgentSessionEventTypes`, and package exports), treated the same way as the internal EOT prediction plumbing.
  - Requires `@livekit/protocol` >= 1.46.8 (adds `EotPrediction.backchannelProbability` and `SessionCreated.defaultBackchannelThresholds` / `defaultBackchannelThreshold`).

- Fix DataStream avatars (Anam, Bey, D-ID, LemonSlice, Runway, Tavus, Trugen) stalling the - [#1795](https://github.com/livekit/agents-js/pull/1795) ([@smorimoto](https://github.com/smorimoto))
  conversation on user interruption when paired with the OpenAI Realtime API.

  `DataStreamAudioOutput` parsed the `lk.playback_finished` RPC payload with a compile-time-only
  `as PlaybackFinishedEvent` cast. The LiveKit avatar protocol serializes that payload with
  snake_case keys (`playback_position`, `synchronized_transcript`) — confirmed against Anam's
  live engine, which emits `{"playback_position": 2.0, "interrupted": true, "synchronized_transcript": null}`
  — so the camelCase `playbackPosition` read back `undefined`. That became
  `Math.floor(undefined * 1000) === NaN`, which `JSON.stringify` serializes as `null` in
  `conversation.item.truncate`; the OpenAI Realtime API then rejected the truncate with an
  `invalid_type` error and the interrupted turn could not recover.

  `DataStreamAudioOutput` now normalizes the wire payload (snake_case primary, camelCase
  fallback), which also restores the previously-dropped `synchronizedTranscript` on interrupted
  turns. As defense-in-depth, the realtime truncate path now clamps a non-finite `audioEndMs` to
  a valid non-negative integer in both `AgentActivity` and the OpenAI plugin so a malformed or
  absent playback position can never again serialize as `null`.

- Fix orphaned WebSocket leak in `connectWs`: when the connection timeout fires, the socket is now terminated so it cannot connect and linger without an owner. Also fixes a hang where a normal (code 1000) close during the handshake left the promise unsettled — it now rejects on any close before the socket opens. Uses `APITimeoutError` instead of `APIConnectionError` for clearer retry semantics. - [#1788](https://github.com/livekit/agents-js/pull/1788) ([@chenghao-mou](https://github.com/chenghao-mou))

- Avoid clearing newer participant entrypoint tasks after quick reconnects. - [#1723](https://github.com/livekit/agents-js/pull/1723) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Remove the `cartesia/ink-2-latest` alias from the Cartesia inference STT model type hints. The alias still works at runtime; dated and `-latest` Cartesia snapshot aliases are no longer surfaced in the SDK types. - [#1792](https://github.com/livekit/agents-js/pull/1792) ([@adrian-cowham](https://github.com/adrian-cowham))

- `SupervisedProc.initialize()` now fails fast — racing the first IPC message against child exit and the initialize timeout — instead of hanging forever when the child process dies before responding (e.g. an inference runner whose model files are missing). Callers that previously deadlocked (worker startup, console mode) now get an actionable error. - [#1706](https://github.com/livekit/agents-js/pull/1706) ([@toubatbrian](https://github.com/toubatbrian))

## 1.4.6

### Patch Changes

- Add the agent participant SID as an `X-LiveKit-Agent-Id` header on inference requests, alongside the existing room and job ID headers, when running inside a job context. - [#1687](https://github.com/livekit/agents-js/pull/1687) ([@adrian-cowham](https://github.com/adrian-cowham))

- Defer AMD listening until the participant audio track is subscribed, and for SIP participants until `sip.callStatus` is `active`, so ringback and early media no longer consume the no-speech budget. After AMD settles on a machine verdict with `interruptOnMachine`, skip the normal auto-reply triggered by user-turn completion so it no longer races with — and interrupts — the caller's own `generateReply` (e.g. leaving a voicemail). - [#1639](https://github.com/livekit/agents-js/pull/1639) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

  Complete the AMD verdict-emission port: add `waitUntilFinished` and `maxEndpointingDelayMs` options and gate emission on both post-speech silence and end-of-turn (machine/uncertain verdicts wait for the turn detector or a fallback backstop; a confident human releases on silence alone). Settle `no_speech_timeout` as `uncertain` instead of `machine-unavailable`. Treat the classifier LLM's tool calls as authoritative — no longer resurrect a verdict by parsing free-text content emitted alongside an `uncertain`/postpone tool call.

  Wire AMD into the recognition-hook layer the way the Python framework does: `AgentActivity` now drives AMD via `onUserSpeechStarted()`, `onUserSpeechEnded(silenceDurationMs)`, and `onTranscript(text, source)` from its VAD/STT hooks, instead of AMD snooping the derived `UserStateChanged`/`UserInputTranscribed` session events. This gives AMD the VAD's real `silenceDuration` directly, so post-speech timers and reported delays are anchored on the true speech-end time rather than skewed by VAD/event latency.

  Port the AMD classification prompt verbatim from the Python framework — restoring the task description, category definitions (`machine-vm` = leaving a message IS possible; `machine-unavailable` = NOT possible), and the few-shot examples that steer borderline cases (hours-of-operation → uncertain, "press 1" → machine-ivr, call-screening → machine-ivr) — and pass the raw transcript as the user message so it matches the prompt's `Input:`/`Output:` pattern.

- feat(voice/avatar): add avatar join waiting and cleanup participant on close - [#1594](https://github.com/livekit/agents-js/pull/1594) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Adaptive interruption detection now omits the threshold from `session.create` unless the user explicitly overrides it, letting the gateway apply its fetched default (surfaced via `default_threshold` on `session.created`). The HTTP transport has been dropped — detection always connects over WebSocket and always requires LiveKit credentials, and its base URL now defaults from `LIVEKIT_INFERENCE_URL` instead of `LIVEKIT_REMOTE_EOT_URL`. Inference requests also send an `X-LiveKit-Worker-Token` header when `LIVEKIT_WORKER_TOKEN` is set (hosted agents); a token supplied via the `--worker-token` CLI flag is now re-exported into the environment so forked job subprocesses inherit it and include the header. The `X-LiveKit-Agent-Id` header is now only attached once the room is connected to avoid leaking an unset local-participant SID. The interruption WebSocket is now closed deterministically on stream teardown (including error and cancel paths) instead of only on graceful completion — previously an orphaned socket leaked per session/activity and accumulated for the worker's lifetime. Mid-session threshold/duration changes via `updateOptions` now reconnect the WebSocket in place rather than closing it and letting the next send error the stream — so option changes no longer consume a failover retry (previously enough updates in a session could exhaust the retry budget and stop interruption detection). - [#1785](https://github.com/livekit/agents-js/pull/1785) ([@chenghao-mou](https://github.com/chenghao-mou))

- Bound AgentSession close during job shutdown so shutdown callbacks still run. - [#1638](https://github.com/livekit/agents-js/pull/1638) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Rate-limit IPC high-memory warnings and include process context in memory logs. - [#1717](https://github.com/livekit/agents-js/pull/1717) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Clamp the STT-derived `lastSpeakingTime` to the current wall-clock time. When the STT stream's clock diverged from the activity's input epoch (e.g. a reused STT pipeline after an agent handoff), the transcript `endTime` could map to a timestamp minutes in the future, causing the end-of-turn bounce task to sleep that long before committing the user turn — the agent appeared to go silent mid-call even though LLM preemptive generation kept running. - [#1782](https://github.com/livekit/agents-js/pull/1782) ([@toubatbrian](https://github.com/toubatbrian))

- increase memory warning threshold - [#1778](https://github.com/livekit/agents-js/pull/1778) ([@davidzhao](https://github.com/davidzhao))

- Support `FlushSentinel` in voice LLM nodes to flush audio and text output per segment. - [#1710](https://github.com/livekit/agents-js/pull/1710) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Support granular recording options in `AgentSession.start`. The `record` option now accepts `boolean | RecordingOptions` (`{ audio, traces, logs, transcript }`); a boolean maps to all-on/all-off and a partial object merges onto all-on, so omitted keys default to `true`. Each category independently gates audio capture, trace export, log export, and transcript upload, mirroring the Python SDK and matching the documented granular form. - [#1702](https://github.com/livekit/agents-js/pull/1702) ([@anzemur](https://github.com/anzemur))

- Guard inference agent ID header lookup until the room is connected. - [#1700](https://github.com/livekit/agents-js/pull/1700) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Preserve OpenAI Responses assistant message phase metadata across follow-up requests. - [#1720](https://github.com/livekit/agents-js/pull/1720) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Close active RecorderIO during job session-end cleanup before generating the session report. - [#1682](https://github.com/livekit/agents-js/pull/1682) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Align `AgentSession.start` recording with the Python SDK's primary-session behavior. The primary/secondary designation now happens in `start()` before `initRecording`, so a demoted secondary session never configures cloud recording. A non-primary session whose `record` argument was not explicitly given now silently disables its recording (instead of throwing); it still throws only when `record` was passed explicitly, matching Python's `record_is_given` semantics. - [#1704](https://github.com/livekit/agents-js/pull/1704) ([@toubatbrian](https://github.com/toubatbrian))

- Restrict STT pipeline reuse during handoff to agents using the default sttNode. - [#1605](https://github.com/livekit/agents-js/pull/1605) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(voice): scope forwardAudio's playback-started listener to its own segment - [#1786](https://github.com/livekit/agents-js/pull/1786) ([@chenghao-mou](https://github.com/chenghao-mou))

  When a speech is interrupted, the scheduling loop immediately authorizes the next
  speech, so the new segment's `forwardAudio` registers its `playback_started`
  listener on the shared audio output while the interrupted segment is still
  emitting events during teardown. The stray event resolved the new segment's
  `firstFrameFut` before its first frame was captured, which skipped resampler
  creation and pushed an unresampled frame straight to the `AudioSource`
  (`RtcError: sample_rate and num_channels don't match`) and corrupted playback
  bookkeeping. The listener now only resolves `firstFrameFut` after the segment has
  captured its own first frame.

- Add `TcpSessionTransport`, a `SessionTransport` that frames protobuf session messages over a raw TCP socket (4-byte big-endian length prefix, 1 MiB cap, `TCP_NODELAY`), mirroring the Python implementation. Also handle the `updateIo` session request in `SessionHost`, toggling input/output audio and transcription. This is the transport plumbing that lets a local broker (e.g. the LiveKit CLI session daemon) drive a Node agent over TCP. - [#1693](https://github.com/livekit/agents-js/pull/1693) ([@toubatbrian](https://github.com/toubatbrian))

- fix(voice): emit the wrapper error (with `recoverable`) on session `error` events instead of the inner error - [#1787](https://github.com/livekit/agents-js/pull/1787) ([@u9g](https://github.com/u9g))

## 1.4.5

### Patch Changes

- Fix `AgentActivity.generateReply` defaulting `toolChoice` to `'none'` on a child `AgentSession` spawned inside a tool. The previous check relied on `AsyncLocalStorage`, which leaks the parent function-call context into the child session and caused the framework to drop legitimate tool calls emitted by the child agent (e.g. the supervisor's `connect_to_caller` invocation in `WarmTransferTask`). The check now uses per-task info, matching the Python implementation. - [#1458](https://github.com/livekit/agents-js/pull/1458) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Block user turn exceeded callbacks while an agent handoff is starting. - [#1614](https://github.com/livekit/agents-js/pull/1614) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix: repair leaked chat-template tokens in function call args - [#1604](https://github.com/livekit/agents-js/pull/1604) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Fix interrupt race that could leak unplayed transcript text. - [#1573](https://github.com/livekit/agents-js/pull/1573) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Wire internal debug messages through remote sessions. - [#1645](https://github.com/livekit/agents-js/pull/1645) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- subscribe to tracks published after connect with AUDIO_ONLY/VIDEO_ONLY - [#1629](https://github.com/livekit/agents-js/pull/1629) ([@toubatbrian](https://github.com/toubatbrian))

- chore(worker): update worker warnings - [#1571](https://github.com/livekit/agents-js/pull/1571) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(inference): stop mislabeling barge-in handler errors as parse failures - [#1619](https://github.com/livekit/agents-js/pull/1619) ([@chenghao-mou](https://github.com/chenghao-mou))

  The interruption WebSocket handler wrapped both `wsMessageSchema.parse` and `handleMessage` in one `try`, so a handler throw (e.g. a late `bargein_detected` prediction enqueued after the readable side was errored/closed) was logged as "Failed to parse WebSocket message" with the real error discarded. Parse and handler errors are now caught separately and log the actual error, and the late barge-in event is dropped quietly (`desiredSize === null`) instead of throwing into a dead stream.

- update rtc sdk to 0.13.29 - [#1652](https://github.com/livekit/agents-js/pull/1652) ([@davidzhao](https://github.com/davidzhao))

- fix(llm): convert per-turn instructions on the first turn for Google provider format - [#1589](https://github.com/livekit/agents-js/pull/1589) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(realtime): process all messages in multi-message realtime generations - [#1628](https://github.com/livekit/agents-js/pull/1628) ([@tinalenguyen](https://github.com/tinalenguyen))

  Reorders audio/text forwarding setup inside `processOneMessage` to match the
  Python source order (audio first, then text), and tightens the playout-await
  guard so `playoutPromise` is only awaited when not interrupted. This fixes a
  case where the second message in a multi-message realtime response (e.g.
  `gpt-realtime-2` preambles) could be dropped.

  Also stamps assistant `ChatMessage.createdAt` with `startedSpeakingAt` (the
  first frame's playback start) instead of defaulting to `Date.now()` at
  end-of-generation. This preserves correct user/assistant ordering in
  `ChatContext` when user transcription items land during agent playout.

- feat(realtime): support multi-message generation per response - [#1555](https://github.com/livekit/agents-js/pull/1555) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Prevent recorder close from hanging during encode cleanup and clamp recorder frame splits to valid frame bounds. - [#1684](https://github.com/livekit/agents-js/pull/1684) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Remove the `ttsPronunciationMap` Agent option (and the `TTSPronunciationMap` type). Use the general `tts_text_transforms` / `replace` text transform for pre-TTS pronunciation replacements instead. - [#1620](https://github.com/livekit/agents-js/pull/1620) ([@u9g](https://github.com/u9g))

- fix: reset user turn tracker when clearing user turn - [#1615](https://github.com/livekit/agents-js/pull/1615) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(voice): make ParticipantAudioOutput.pause() actually gate audio (port \_playback_enabled + synchronizer pause) - [#1579](https://github.com/livekit/agents-js/pull/1579) ([@toubatbrian](https://github.com/toubatbrian))

- Replace discarded input audio with silence for STT and realtime model streams. - [#1601](https://github.com/livekit/agents-js/pull/1601) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix: make non-transient 4xx API status errors non-retryable - [#1597](https://github.com/livekit/agents-js/pull/1597) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- feat: allow updating dynamic endpointing alpha on active sessions - [#1634](https://github.com/livekit/agents-js/pull/1634) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- feat(google): add Vertex AI Model Garden LLM integration - [#1606](https://github.com/livekit/agents-js/pull/1606) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add Soniox STT support and surface per-run source and target language segments on STT speech data. - [#1602](https://github.com/livekit/agents-js/pull/1602) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(llm): sort function tools to keep tool order invariant. - [#1641](https://github.com/livekit/agents-js/pull/1641) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Update download-files deprecation message - [#1621](https://github.com/livekit/agents-js/pull/1621) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Use STT transcript timestamps for last speaking time when VAD is unavailable or misses speech. - [#1603](https://github.com/livekit/agents-js/pull/1603) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(voice): surface tool-argument validation errors to the LLM instead of returning a generic "internal error" - [#1606](https://github.com/livekit/agents-js/pull/1606) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

  When an LLM-generated tool call failed JSON parsing or Zod schema validation, the framework returned `"An internal error occurred"` to the LLM, which left the model with no way to correct itself — causing it to loop on the same invalid call. Argument-validation failures are now wrapped in a `ToolError` whose message includes the tool name and the validator's diagnostic, so the LLM can fix its arguments.

  Behavior is unchanged for exceptions thrown from inside a tool's `execute`: regular `Error`s are still masked as `"An internal error occurred"` to avoid leaking server-side details, and `ToolError` continues to be the supported way to forward a custom message to the LLM.

- Make `ToolOptions.abortSignal` required. The framework always provides an `AbortSignal` to tool execution, so the field is no longer optional. Tool authors can rely on `abortSignal` always being defined and drop defensive `if (abortSignal)` checks. - [#1678](https://github.com/livekit/agents-js/pull/1678) ([@toubatbrian](https://github.com/toubatbrian))

- Reset active VAD streams on flush so STT end-of-speech can recover without recreating streams. STT end-of-speech now preserves the VAD-owned `lastSpeakingTime` instead of overwriting it, keeping the end-of-turn "no new speech" check reliable when VAD is active. - [#1574](https://github.com/livekit/agents-js/pull/1574) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add beta WarmTransferTask workflow for SIP-based human handoffs. - [#1458](https://github.com/livekit/agents-js/pull/1458) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

## 1.4.4

### Patch Changes

- Add avatar join and playback latency metrics. - [#1537](https://github.com/livekit/agents-js/pull/1537) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(generation): preserve LLM-supplied call_id instead of overwriting with item id - [#1524](https://github.com/livekit/agents-js/pull/1524) ([@toubatbrian](https://github.com/toubatbrian))

- Add support for Rime time scale factor options on arcana, coda, and mistv3. - [#1557](https://github.com/livekit/agents-js/pull/1557) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(voice): cancel realtime generation when speech is interrupted - [#1503](https://github.com/livekit/agents-js/pull/1503) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Fix playback flush and speech interruption races - [#1518](https://github.com/livekit/agents-js/pull/1518) ([@toubatbrian](https://github.com/toubatbrian))

- fix(telemetry): export observability logs from logger instances captured before OTEL setup. - [#1562](https://github.com/livekit/agents-js/pull/1562) ([@Cay-Zhang](https://github.com/Cay-Zhang))

- Add VAD-driven finalization for Speechmatics inference STT. - [#1526](https://github.com/livekit/agents-js/pull/1526) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(voice): allow true interruptions during backchannel boundary cooldown - [#1565](https://github.com/livekit/agents-js/pull/1565) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add user turn limit options for interrupting long user speech. - [#1535](https://github.com/livekit/agents-js/pull/1535) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

## 1.4.3

### Patch Changes

- Improve audio discard checks - [#1504](https://github.com/livekit/agents-js/pull/1504) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add dynamic endpointing for voice turn handling. - [#1475](https://github.com/livekit/agents-js/pull/1475) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(stt): reflect active child in `FallbackAdapter` `model`/`provider` - [#1515](https://github.com/livekit/agents-js/pull/1515) ([@julien-lottie](https://github.com/julien-lottie))

  `audio_recognition.refreshUserTurnSttAttributes` reads these on every
  STT event to stamp `gen_ai.request.model` / `gen_ai.provider.name`
  on the `user_turn` span. With static wrapper labels, every span
  reported `FallbackAdapter` / `livekit` regardless of which provider
  actually transcribed — so a mid-turn fallover was invisible in
  traces. Track the elected child from both the streaming and
  recognize paths and surface its identifiers.

- Add beta workflow InstructionParts exports. - [#1500](https://github.com/livekit/agents-js/pull/1500) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add `updateOptions` support to inference LLM for live model swaps. - [#1527](https://github.com/livekit/agents-js/pull/1527) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix audio resampler memory leak. - [#1453](https://github.com/livekit/agents-js/pull/1453) ([@KrishnaShuk](https://github.com/KrishnaShuk))

- feat(agents): add modality-aware `Instructions` with audio/text variants - [#1484](https://github.com/livekit/agents-js/pull/1484) ([@toubatbrian](https://github.com/toubatbrian))

  Introduce a new `Instructions` class for system prompts that adapt to the
  user's input modality. The pipeline now applies the matching variant before
  each LLM turn based on `SpeechHandle.inputDetails.modality`, and
  `AgentSession.generateReply()` and `AgentSession.run()` expose an
  `inputModality` option. `Instructions.tpl` supports JS-native prompt
  composition while preserving audio/text variants.

- brianyin/agt-2866-delete-room-on-session-close - [#1501](https://github.com/livekit/agents-js/pull/1501) ([@toubatbrian](https://github.com/toubatbrian))

- fix(agents): await realtime auto tool replies in RunResult - [#1490](https://github.com/livekit/agents-js/pull/1490) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Add support for the Rime Coda TTS model. - [#1523](https://github.com/livekit/agents-js/pull/1523) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- feat(agents): add Speechmatics inference STT model options. - [#1507](https://github.com/livekit/agents-js/pull/1507) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- feat(agents): add `livekit-agents download-files` command for Docker layer caching - [#1511](https://github.com/livekit/agents-js/pull/1511) ([@davidzhao](https://github.com/davidzhao))

  Adds a standalone CLI (`npx livekit-agents download-files`) that discovers installed
  `@livekit/agents-plugin-*` packages and downloads their asset files without loading
  the user's agent code.

- fix(barge-in): suppress session-level barge-in errors. - [#1513](https://github.com/livekit/agents-js/pull/1513) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

## 1.4.2

### Patch Changes

- fix: do not republish background audio tracks after reconnect - [#1487](https://github.com/livekit/agents-js/pull/1487) ([@davidzhao](https://github.com/davidzhao))

- Fail download-files when plugin downloads fail - [#1481](https://github.com/livekit/agents-js/pull/1481) ([@toubatbrian](https://github.com/toubatbrian))

- chore(amd): update default models and drop null support - [#1476](https://github.com/livekit/agents-js/pull/1476) ([@chenghao-mou](https://github.com/chenghao-mou))

- Add TTS pronunciation customization support to agents, Google Gemini TTS, and Sarvam TTS. - [#1473](https://github.com/livekit/agents-js/pull/1473) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- chore(amd): add default amd prediction log - [#1496](https://github.com/livekit/agents-js/pull/1496) ([@chenghao-mou](https://github.com/chenghao-mou))

- Add TTS text transforms with built-in markdown/emoji filtering, streaming replacement, and custom callable transform support. - [#1477](https://github.com/livekit/agents-js/pull/1477) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

## 1.4.1

### Patch Changes

- Expose `AgentSessionOptions.ttsReadIdleTimeout` and `AgentSessionOptions.forwardAudioIdleTimeout` to configure the two pipeline stall guards in `performTTSInference` and `performAudioForwarding`. Useful for custom LLM/TTS backends whose first-token latency can legitimately exceed the previous 10s default. Defaults remain 10 seconds, preserving existing behavior. - [#1461](https://github.com/livekit/agents-js/pull/1461) ([@s-hamdananwar](https://github.com/s-hamdananwar))

- Make default user turn span start times explicit. - [#1456](https://github.com/livekit/agents-js/pull/1456) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Prevent voice pipeline scheduling from hanging when a pipeline task crashes after a speech handle is already marked done. - [#1423](https://github.com/livekit/agents-js/pull/1423) ([@u9g](https://github.com/u9g))

- fix(google): abort pending realtime sends during reconnect - [#1415](https://github.com/livekit/agents-js/pull/1415) ([@u9g](https://github.com/u9g))

- docs(agents): document realtime capabilities - [#1419](https://github.com/livekit/agents-js/pull/1419) ([@u9g](https://github.com/u9g))

- feat(inference): propagate STT extra to SpeechData.metadata - [#1389](https://github.com/livekit/agents-js/pull/1389) ([@toubatbrian](https://github.com/toubatbrian))

  The inference STT plugin now plumbs the gateway's per-transcript `extra` field
  onto `SpeechData.metadata`, exposing provider-specific signals (e.g. Inworld
  voice profile, xAI `speech_final`) to consumers.

- fix(worker): use available CPU cores for numIdleProcesses in production - [#1449](https://github.com/livekit/agents-js/pull/1449) ([@KrishnaShuk](https://github.com/KrishnaShuk))

- fix(transcription): rstrip punctuation from interim segments - [#1447](https://github.com/livekit/agents-js/pull/1447) ([@KrishnaShuk](https://github.com/KrishnaShuk))

- Emit agent configuration updates in OTLP session logs. - [#1434](https://github.com/livekit/agents-js/pull/1434) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- fix(agents): persist user turn start across VAD bursts - [#1457](https://github.com/livekit/agents-js/pull/1457) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Support OpenAI Realtime Whisper STT - [#1429](https://github.com/livekit/agents-js/pull/1429) ([@toubatbrian](https://github.com/toubatbrian))

## 1.4.0

### Minor Changes

- `voice.AMD` reaches feature completion. - [#1390](https://github.com/livekit/agents-js/pull/1390) ([@toubatbrian](https://github.com/toubatbrian))

### Patch Changes

- fix(agents): support constructing `AgentSession` with no arguments - [#1410](https://github.com/livekit/agents-js/pull/1410) ([@u9g](https://github.com/u9g))

- `AMD`: cancel the pre-baked HUMAN/`short_greeting` silence timer when a final STT transcript arrives inside the short-speech window, replacing it with a `long_speech` timer anchored at `speechEndedAt + MACHINE_SILENCE_THRESHOLD_MS` so the LLM verdict gets the final word. Mirrors the python fix in [`livekit/agents#5637`](https://github.com/livekit/agents/pull/5637). - [#1390](https://github.com/livekit/agents-js/pull/1390) ([@toubatbrian](https://github.com/toubatbrian))

- Port AMD improvements from python `livekit/agents#5584`. `voice.AMD` now exposes the previously hard-coded timing thresholds (`humanSpeechThresholdMs`, `humanSilenceThresholdMs`, `machineSilenceThresholdMs`) and the classification `prompt` as constructor options, defers to the LLM (instead of forcing a HUMAN verdict) when a transcript is already available after a short greeting, and accepts a `participantIdentity` hint plus a `suppressCompatibilityWarning` flag. The classifier now offers two LLM tools — `save_prediction` and `postpone_termination` (capped at 3 extensions × 10s) — letting the model request more audio when the transcript is ambiguous; if the model returns plain JSON instead of tool calls, AMD falls back to the previous content-parsing path. AMD also logs a one-shot warning when the resolved LLM is not in the bundled `EVALUATED_LLM_MODELS` list. - [#1368](https://github.com/livekit/agents-js/pull/1368) ([@toubatbrian](https://github.com/toubatbrian))

- fix(inference): make `inference.LLM` compatible with openai >= 6.36.0 - [#1411](https://github.com/livekit/agents-js/pull/1411) ([@u9g](https://github.com/u9g))

- Add comments to agent side and inference side fallback adapters - [#1398](https://github.com/livekit/agents-js/pull/1398) ([@tmshapland](https://github.com/tmshapland))

- refactor(agents): replace uuid with crypto.randomUUID - [#1392](https://github.com/livekit/agents-js/pull/1392) ([@benasher44](https://github.com/benasher44))

## 1.3.4

### Patch Changes

- Add support for the new `inworld-tts-2` Inworld TTS model. - [#1396](https://github.com/livekit/agents-js/pull/1396) ([@toubatbrian](https://github.com/toubatbrian))

  - Adds `inworld/inworld-tts-2` to the `InworldModels` union exported from
    `@livekit/agents/inference` so the model is selectable when using the
    LiveKit Inference Gateway TTS client.
  - Exports a new `TTSModels` type from `@livekit/agents-plugin-inworld`
    (`'inworld-tts-2' | 'inworld-tts-1.5-max'`) and updates `TTSOptions.model`
    to `TTSModels | string`, mirroring the Python plugin so callers get
    autocomplete for the curated model names while still being able to pass
    any custom model id.

  Ports https://github.com/livekit/agents/pull/5646 from `livekit/agents`.

## 1.3.3

### Patch Changes

- Port the barge-in cooldown / `backchannelBoundary` interruption window from Python (livekit/agents#5269). When the agent starts speaking, VAD-based interruption now stays active for a configurable cooldown (default `1000` ms) before being disabled, allowing the user to quickly correct themselves at the start of the agent's turn. When the agent finishes speaking, transcripts whose end time falls within the trailing cooldown (default `3500` ms) are released as normal user input instead of being held, surfacing premature answers to the agent's last sentence. The cooldown is configured via `turnHandling.interruption.backchannelBoundary` (a single number applies to both sides; pass `[start, end]` to configure them separately, or `null` to disable). - [#1366](https://github.com/livekit/agents-js/pull/1366) ([@toubatbrian](https://github.com/toubatbrian))

- feat(stt): add FakeSTT test harness for FallbackAdapter - [#1288](https://github.com/livekit/agents-js/pull/1288) ([@drain-zine](https://github.com/drain-zine))

- Harden RecorderIO teardown by fencing writes before channel closure and stopping - [#1378](https://github.com/livekit/agents-js/pull/1378) ([@toubatbrian](https://github.com/toubatbrian))
  the forward task first, preventing repeated closed WritableStream write errors on disconnect.
  Also centralize writable-stream closed error detection in utils and add regression tests.

## 1.3.2

### Patch Changes

- Add `voice.AvatarSession` base class and port the asymmetric-detach warning from the Python `TranscriptSynchronizer`. The new base class registers `aclose` as a job shutdown callback and warns when an avatar session is started after `AgentSession.start()` has already wired an audio output. The transcript synchronizer now tracks `_audioAttached` / `_textAttached` via `onAttached` / `onDetached` and logs a one-shot warning when audio or text is detached asymmetrically (covering external avatars and manual `session.output.audio` / `.transcription` replacement). Existing avatar plugins (anam, bey, lemonslice, trugen) now inherit from `voice.AvatarSession` and call `super.start(agentSession, room)` first. - [#1280](https://github.com/livekit/agents-js/pull/1280) ([@toubatbrian](https://github.com/toubatbrian))

- fix(inference): drop streamed assistant text from tool call chunks - [#1359](https://github.com/livekit/agents-js/pull/1359) ([@Genmin](https://github.com/Genmin))

- fix(inference): update tts event name and drop unkown type warning - [#1354](https://github.com/livekit/agents-js/pull/1354) ([@chenghao-mou](https://github.com/chenghao-mou))

- Port the `liveavatar` plugin from the Python `livekit-agents` repo, including the new `videoQuality` parameter from livekit/agents#5552. - [#1324](https://github.com/livekit/agents-js/pull/1324) ([@toubatbrian](https://github.com/toubatbrian))

  The new `@livekit/agents-plugin-liveavatar` package adds a LiveAvatar `AvatarSession` that mirrors the Python plugin: it brings up a LiveAvatar streaming session, opens the realtime websocket, captures the agent's audio output through a queue-based `AudioOutput`, resamples to 24 kHz mono, and forwards base64-encoded chunks (~600 ms first chunk, ~1 s subsequent) to the LiveAvatar service. Inbound websocket events drive playback start/finish notifications back into the `AgentSession`.

  Also exports `voice.AudioOutput` (and its companion `AudioOutputCapabilities` / `PlaybackFinishedEvent` / `PlaybackStartedEvent` types) from `@livekit/agents` so plugin authors can subclass the abstract audio sink.

- feat(telemetry): expose provider request ids on STT/TTS/LLM spans for debugging - [#1319](https://github.com/livekit/agents-js/pull/1319) ([@toubatbrian](https://github.com/toubatbrian))

  Adds the `lk.provider_request_ids` (string[], deduped) span attribute to the
  `user_turn` (STT), `tts_request_run` (TTS), and `llm_request_run` (LLM) spans
  so users can correlate traces with the provider's server-side logs.

- emit agent handoffs under conversationitemadded - [#1347](https://github.com/livekit/agents-js/pull/1347) ([@tinalenguyen](https://github.com/tinalenguyen))

- feat(room-io): add `jsonFormat` option on `RoomOutputOptions` for timed transcription output. When enabled, each chunk published on the `lk.transcription` datastream topic is a JSON object with `text`, and `start_time`/`end_time` when the chunk is a `TimedString`. Ported from livekit/agents#5472. - [#1305](https://github.com/livekit/agents-js/pull/1305) ([@toubatbrian](https://github.com/toubatbrian))

- Port livekit/agents#5511 + #5532: - [#1304](https://github.com/livekit/agents-js/pull/1304) ([@toubatbrian](https://github.com/toubatbrian))

  - **feat(avatar): add `lk.playback_started` RPC support to `DataStreamAudioOutput`** — new `waitPlaybackStart` constructor option (default `false`). When `true`, the `playbackStarted` event is deferred until the remote avatar worker invokes the `lk.playback_started` RPC instead of firing eagerly on the first captured frame.
  - **fix/refactor(transcription): drive `SegmentSynchronizerImpl` start-time off `onPlaybackStarted`** — `startWallTime` and `startFuture` are now set when the audio output reports playback start (chained automatically through `SyncedAudioOutput.onPlaybackStarted`), rather than when the first audio frame is pushed. Combined with the close-path fallback from #5532 this keeps the synchronizer correct for both eager (room) and deferred (avatar RPC) playback timing.

  Note: only the consumer side (the agent registering the RPC handler and surfacing the event) is included; agents-js does not have an `AvatarRunner` / `DataStreamAudioReceiver`, so the producer-side `notifyPlaybackStarted` is skipped.

- Gracefully handle unknown inference TTS event type - [#1333](https://github.com/livekit/agents-js/pull/1333) ([@toubatbrian](https://github.com/toubatbrian))

- chore(deps): update @livekit/rtc-node to 0.13.27 - [#1331](https://github.com/livekit/agents-js/pull/1331) ([@toubatbrian](https://github.com/toubatbrian))

- fix lockfile - [#1340](https://github.com/livekit/agents-js/pull/1340) ([@toubatbrian](https://github.com/toubatbrian))

- support new realtime model capability for native transcript synchronization, set to true for phonic - [#1329](https://github.com/livekit/agents-js/pull/1329) ([@tinalenguyen](https://github.com/tinalenguyen))

- feat: Resume false interruption feature - [#1320](https://github.com/livekit/agents-js/pull/1320) ([@toubatbrian](https://github.com/toubatbrian))

## 1.3.1

### Minor Changes

- feat(inference/tts): detect aligned transcript capability from provider `modelOptions` (`cartesia.add_timestamps`, `elevenlabs.sync_alignment`, `inworld.timestamp_type`) and forward the gateway's `output_timestamps` WebSocket events as `TimedString` word/character timings attached to the next synthesized audio frame. Ported from livekit/agents#5534. - [#1311](https://github.com/livekit/agents-js/pull/1311) ([@toubatbrian](https://github.com/toubatbrian))

### Patch Changes

- fix(voice): await initRecording() to prevent OTEL trace loss in short sessions - [#1300](https://github.com/livekit/agents-js/pull/1300) ([@moyounishimself](https://github.com/moyounishimself))

- support LIVEKIT_AGENT_NAME env var - [#1332](https://github.com/livekit/agents-js/pull/1332) ([@toubatbrian](https://github.com/toubatbrian))

- fix(deps): update dependency uuid to v14 [security] - [#1313](https://github.com/livekit/agents-js/pull/1313) ([@renovate](https://github.com/apps/renovate))

- feat(metrics): add `playbackLatency` metric on assistant `ChatMessage`s - [#1323](https://github.com/livekit/agents-js/pull/1323) ([@toubatbrian](https://github.com/toubatbrian))

## 1.3.0

### Minor Changes

- feat(stt): add FallbackAdapter for automatic STT provider failover - [#1278](https://github.com/livekit/agents-js/pull/1278) ([@drain-zine](https://github.com/drain-zine))

### Patch Changes

- replcae sentencetokenizer with wordtokenizer - [#1312](https://github.com/livekit/agents-js/pull/1312) ([@tinalenguyen](https://github.com/tinalenguyen))

- add `preserveFunctionCallHistory` option to `AgentTask` and `TaskGroup` and use function call history in Phonic plugin - [#1285](https://github.com/livekit/agents-js/pull/1285) ([@qionghuang6](https://github.com/qionghuang6))

## 1.2.8

### Patch Changes

- Add Deepgram `flux-general-multi` STTv2 model support with multi-language detection. Introduces a new `languageHint` option for biasing the model toward specific languages (only used by `flux-general-multi`), and adds a new `sourceLanguages` field on `SpeechData` that carries all detected languages sorted by prevalence. For multi-language detection, the dominant language is set on `language` while `sourceLanguages` retains the full list. - [#1275](https://github.com/livekit/agents-js/pull/1275) ([@toubatbrian](https://github.com/toubatbrian))

- fix(voice): don't commit unplayed LLM response to chat context when interruption happens before any text is synchronized - [#1270](https://github.com/livekit/agents-js/pull/1270) ([@u9g](https://github.com/u9g))

- feat(stt): add diarization capabilities and speaker_id support - [#1267](https://github.com/livekit/agents-js/pull/1267) ([@toubatbrian](https://github.com/toubatbrian))

- feat(voice): add PreemptiveGenerationOptions for fine-grained control - [#1265](https://github.com/livekit/agents-js/pull/1265) ([@toubatbrian](https://github.com/toubatbrian))

## 1.2.7

### Patch Changes

- feat: add dedent tagged template literal helper - [#1259](https://github.com/livekit/agents-js/pull/1259) ([@u9g](https://github.com/u9g))

- fix(inference): accept numeric STT error codes - [#1231](https://github.com/livekit/agents-js/pull/1231) ([@Maples7](https://github.com/Maples7))

- feat: add UserData generic to JobProcess, JobContext, and defineAgent - [#1250](https://github.com/livekit/agents-js/pull/1250) ([@u9g](https://github.com/u9g))

- Update all ws usage to use the same version - [#1239](https://github.com/livekit/agents-js/pull/1239) ([@lukasIO](https://github.com/lukasIO))

- feat(inference): handle preflight_transcript events in inference STT plugin - [#1228](https://github.com/livekit/agents-js/pull/1228) ([@adrian-cowham](https://github.com/adrian-cowham))

- fix: add `required` parameter to `getJobContext()`, matching Python SDK's `get_job_context(required=False)` pattern. Removes noisy warn-level log during evals/tests. - [#1253](https://github.com/livekit/agents-js/pull/1253) ([@u9g](https://github.com/u9g))

- feat(voice): add answering machine detection - [#1215](https://github.com/livekit/agents-js/pull/1215) ([@chenghao-mou](https://github.com/chenghao-mou))

- fix(voice): allow awaiting speech handles from inside function tools; make SpeechHandle awaitable - [#1266](https://github.com/livekit/agents-js/pull/1266) ([@u9g](https://github.com/u9g))

- feat(inference): introduce XAIModels type and enhance LLMModels with reasoning support - [#1241](https://github.com/livekit/agents-js/pull/1241) ([@russellmartin-livekit](https://github.com/russellmartin-livekit))

- Use ThrowsPromise helper across agent package - [#1249](https://github.com/livekit/agents-js/pull/1249) ([@lukasIO](https://github.com/lukasIO))

- fix: avoid retrying aborted LLM requests during shutdown - [#1247](https://github.com/livekit/agents-js/pull/1247) ([@tobiplancraft](https://github.com/tobiplancraft))

## 1.2.6

### Patch Changes

- Add get_framework_info request/response support - [#1223](https://github.com/livekit/agents-js/pull/1223) ([@toubatbrian](https://github.com/toubatbrian))

- update readme with community link - [#1225](https://github.com/livekit/agents-js/pull/1225) ([@tinalenguyen](https://github.com/tinalenguyen))

- refactor \_updateSession in phonic and base realtimesession class - [#1224](https://github.com/livekit/agents-js/pull/1224) ([@tinalenguyen](https://github.com/tinalenguyen))

## 1.2.5

### Patch Changes

- expose serviceTier in CompletionUsage from OpenAI Responses API - [#1205](https://github.com/livekit/agents-js/pull/1205) ([@piyush-gambhir](https://github.com/piyush-gambhir))

- Fix extra_headers being sent in OpenAI request body instead of as HTTP headers in inference LLM - [#1216](https://github.com/livekit/agents-js/pull/1216) ([@smorimoto](https://github.com/smorimoto))

- remove rt session say logic and add phonic logic for resetting ws conn - [#1177](https://github.com/livekit/agents-js/pull/1177) ([@toubatbrian](https://github.com/toubatbrian))

- fix(tts): unblock FallbackAdapter when primary provider fails silently - [#1218](https://github.com/livekit/agents-js/pull/1218) ([@mrniket](https://github.com/mrniket))

- - Make reusable Realtime Session across Handoffs & Agent Tasks - [#1177](https://github.com/livekit/agents-js/pull/1177) ([@toubatbrian](https://github.com/toubatbrian))
  - Add say() capability to phonic realtime model

- Reuse STT Pipeline Across Agent Handoff - [#1177](https://github.com/livekit/agents-js/pull/1177) ([@toubatbrian](https://github.com/toubatbrian))

## 1.2.4

### Patch Changes

- fix(agents): release initMutex after warming to restore pool concurrency - [#1214](https://github.com/livekit/agents-js/pull/1214) ([@drain-zine](https://github.com/drain-zine))

- fix: pass queueSizeMs from RoomOutputOptions through to AudioSource - [#1207](https://github.com/livekit/agents-js/pull/1207) ([@cxyangs](https://github.com/cxyangs))

- Add prompt_cache_retention option to inference - [#1212](https://github.com/livekit/agents-js/pull/1212) ([@s-hamdananwar](https://github.com/s-hamdananwar))

- (inference): add debug metadata headers to inference requests - [#1208](https://github.com/livekit/agents-js/pull/1208) ([@adrian-cowham](https://github.com/adrian-cowham))

- Explicitly close AudioResampler instances too free up resources - [#1210](https://github.com/livekit/agents-js/pull/1210) ([@lukasIO](https://github.com/lukasIO))

## 1.2.3

### Patch Changes

- Fix worker draining behaviour - [#1180](https://github.com/livekit/agents-js/pull/1180) ([@lukasIO](https://github.com/lukasIO))

- Fix Queue dropping falsy items - [#1190](https://github.com/livekit/agents-js/pull/1190) ([@lukasIO](https://github.com/lukasIO))

- fix: Address 6 bugs from Detail scan (March 25) - [#1182](https://github.com/livekit/agents-js/pull/1182) ([@toubatbrian](https://github.com/toubatbrian))

  - inference/llm: pass abort signal to OpenAI SDK and check abort in outer streaming loop
  - llm/fallback_adapter: call tryRecovery() before throwing on mid-stream failure
  - openai/realtime: clear responseCreatedFutures on reconnect to prevent generateReply() hang
  - deepgram/tts: reject on network errors instead of swallowing them
  - cpu: remove Math.max clamp in cgroup v1 so fractional CPU limits are reported correctly
  - openai/responses: handle response.failed event in HTTP streaming

- fix: address 5 Detail scan bugs from March 11 (reconnect, mutex leak, playout, ordering, retryability) - [#1188](https://github.com/livekit/agents-js/pull/1188) ([@toubatbrian](https://github.com/toubatbrian))

- fix(voice): reset VAD on premature STT EOT & guard empty recorder frames - [#1181](https://github.com/livekit/agents-js/pull/1181) ([@toubatbrian](https://github.com/toubatbrian))

## 1.2.2

### Patch Changes

- fix: Include session usage in reports and emit usage updates - [#1161](https://github.com/livekit/agents-js/pull/1161) ([@toubatbrian](https://github.com/toubatbrian))

- Handle unhandled rejection from fire-and-forget run() in SupervisedProc - [#1158](https://github.com/livekit/agents-js/pull/1158) ([@Raysharr](https://github.com/Raysharr))

- fix: add idle timeouts to TTS stream reads to prevent agent stuck in speaking state - [#1174](https://github.com/livekit/agents-js/pull/1174) ([@toubatbrian](https://github.com/toubatbrian))

- Guard WritableStream close in RoomIO teardown to prevent ERR_INVALID_STATE when writer is already closed or errored during concurrent speech interruption - [#1172](https://github.com/livekit/agents-js/pull/1172) ([@Raysharr](https://github.com/Raysharr))

- fix(IPC): graceful handling when channel closes during inference - [#1168](https://github.com/livekit/agents-js/pull/1168) ([@toubatbrian](https://github.com/toubatbrian))

- Add chatCtx and ChatMessage support to AgentSession.generateReply - [#1170](https://github.com/livekit/agents-js/pull/1170) ([@toubatbrian](https://github.com/toubatbrian))

- fix: handle unhandled 'error' event on FfmpegCommand in audio.ts - [#1173](https://github.com/livekit/agents-js/pull/1173) ([@enriqueespaillat-gyde](https://github.com/enriqueespaillat-gyde))

## 1.2.1

### Patch Changes

- Ensure delay doesn't reject with undefined - [#1152](https://github.com/livekit/agents-js/pull/1152) ([@lukasIO](https://github.com/lukasIO))

- Action-aware history summarization - [#1146](https://github.com/livekit/agents-js/pull/1146) ([@toubatbrian](https://github.com/toubatbrian))

- Increase typesaftey for transport - [#1159](https://github.com/livekit/agents-js/pull/1159) ([@lukasIO](https://github.com/lukasIO))

- fix: Align inference TTS provider options - [#1160](https://github.com/livekit/agents-js/pull/1160) ([@toubatbrian](https://github.com/toubatbrian))

## 1.2.0

### Minor Changes

- - Add adaptive interruption handling - [#1002](https://github.com/livekit/agents-js/pull/1002) ([@lukasIO](https://github.com/lukasIO))
  - Add remote session event handler

### Patch Changes

- Support Image Input for OpenAI realtime model - [#1094](https://github.com/livekit/agents-js/pull/1094) ([@toubatbrian](https://github.com/toubatbrian))

- Fix hanging process when participant disconnects during init - [#1087](https://github.com/livekit/agents-js/pull/1087) ([@lukasIO](https://github.com/lukasIO))

## 1.1.0

deprecated

## 1.0.51

### Patch Changes

- Standardize LanguageCode handling - [#1120](https://github.com/livekit/agents-js/pull/1120) ([@toubatbrian](https://github.com/toubatbrian))

- Bun and deno runtime stream release fixes - [#1135](https://github.com/livekit/agents-js/pull/1135) ([@lukasIO](https://github.com/lukasIO))

- Prevent mainTask hang when speech handle is interrupted after authorization - [#1126](https://github.com/livekit/agents-js/pull/1126) ([@enriqueespaillat-gyde](https://github.com/enriqueespaillat-gyde))

## 1.0.50

### Patch Changes

- fix: handle channel close errors in safeSend during shutdown - [#1110](https://github.com/livekit/agents-js/pull/1110) ([@haroldfabla2-hue](https://github.com/haroldfabla2-hue))

- Skip speech handles that are already interrupted when processing queue - [#1090](https://github.com/livekit/agents-js/pull/1090) ([@lukasIO](https://github.com/lukasIO))

## 1.0.49

### Patch Changes

- Use cgroup-aware CPU monitoring inside Docker containers - [#1099](https://github.com/livekit/agents-js/pull/1099) ([@toubatbrian](https://github.com/toubatbrian))

- Add GPT-5.4 to inference OpenAIModels type - [#1105](https://github.com/livekit/agents-js/pull/1105) ([@Topherhindman](https://github.com/Topherhindman))

- Add AEC warmup functionality to AgentSession and AgentActivity - [#1091](https://github.com/livekit/agents-js/pull/1091) ([@toubatbrian](https://github.com/toubatbrian))

- Ensure input stream is only tee'd when it's actually being used - [#1088](https://github.com/livekit/agents-js/pull/1088) ([@lukasIO](https://github.com/lukasIO))

- Support gateway Inworld model options - [#1102](https://github.com/livekit/agents-js/pull/1102) ([@toubatbrian](https://github.com/toubatbrian))

- fix: prevent shutdown hang when speech is active during disconnect - [#1100](https://github.com/livekit/agents-js/pull/1100) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.48

### Patch Changes

- Handle participant disconnect during init - [#1065](https://github.com/livekit/agents-js/pull/1065) ([@Fox32](https://github.com/Fox32))

- Add TaskGroup feature - [#1072](https://github.com/livekit/agents-js/pull/1072) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.47

### Patch Changes

- Change logger to use error serializer - [#1063](https://github.com/livekit/agents-js/pull/1063) ([@qionghuang6](https://github.com/qionghuang6))

- Implement AgentTask feature - [#1045](https://github.com/livekit/agents-js/pull/1045) ([@toubatbrian](https://github.com/toubatbrian))

- add openai responses api llm - [#958](https://github.com/livekit/agents-js/pull/958) ([@tinalenguyen](https://github.com/tinalenguyen))

- Ensure registered plugin versions stay up to date - [#1064](https://github.com/livekit/agents-js/pull/1064) ([@lukasIO](https://github.com/lukasIO))

## 1.0.46

### Patch Changes

- feat: Create MultiInputStream API primitive - [#1036](https://github.com/livekit/agents-js/pull/1036) ([@toubatbrian](https://github.com/toubatbrian))

- Add comprehensive user span instrumentations - [#1027](https://github.com/livekit/agents-js/pull/1027) ([@toubatbrian](https://github.com/toubatbrian))

- Add phonic realtime model - [#1062](https://github.com/livekit/agents-js/pull/1062) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.45

### Patch Changes

- Only shutdown processor when closing input - [#1051](https://github.com/livekit/agents-js/pull/1051) ([@lukasIO](https://github.com/lukasIO))

- Fix Cartesia TTS first-connect timeouts (happy-eyeballs) and prevent ws teardown crashes - [#1023](https://github.com/livekit/agents-js/pull/1023) ([@toubatbrian](https://github.com/toubatbrian))

- Add FallbackAdapter for TTS failover support - [#1022](https://github.com/livekit/agents-js/pull/1022) ([@gokuljs](https://github.com/gokuljs))

- Enable inheritance from VADStream - [#1048](https://github.com/livekit/agents-js/pull/1048) ([@lukasIO](https://github.com/lukasIO))

## 1.0.44

### Patch Changes

- Fix parsing lang from stt ctor - [#1028](https://github.com/livekit/agents-js/pull/1028) ([@adrian-cowham](https://github.com/adrian-cowham))

- Dispose native FFI resources before process.exit() in job shutdown to prevent libc++abi mutex crash - [#1042](https://github.com/livekit/agents-js/pull/1042) ([@Raysharr](https://github.com/Raysharr))

- Ensure resampling is skipped for empty audio frames - [#1044](https://github.com/livekit/agents-js/pull/1044) ([@lukasIO](https://github.com/lukasIO))

## 1.0.43

### Patch Changes

- Support fallback API for inference STT and TTS - [#1029](https://github.com/livekit/agents-js/pull/1029) ([@toubatbrian](https://github.com/toubatbrian))

- Fix support for CJS runners - [#1031](https://github.com/livekit/agents-js/pull/1031) ([@lukasIO](https://github.com/lukasIO))

- Fix generateReply adding duplicate instructions - [#1033](https://github.com/livekit/agents-js/pull/1033) ([@Fox32](https://github.com/Fox32))

## 1.0.42

### Patch Changes

- Fix dispatching empty STT final transcript event - [#1024](https://github.com/livekit/agents-js/pull/1024) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.41

### Patch Changes

- fix: dev command now correctly defaults to debug log level - [#1020](https://github.com/livekit/agents-js/pull/1020) ([@toubatbrian](https://github.com/toubatbrian))

- Implement tts aligned transcripts - [#990](https://github.com/livekit/agents-js/pull/990) ([@toubatbrian](https://github.com/toubatbrian))

- increase AudioMixer default timeout in background audio player - [#1021](https://github.com/livekit/agents-js/pull/1021) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.40

### Patch Changes

- Implement health check - [#996](https://github.com/livekit/agents-js/pull/996) ([@andrewnitu](https://github.com/andrewnitu))

  Change the health check from always returning healthy to returning the status of the following two criteria:

  - agent is connected to livekit server
  - agent's inference executor is running

- fix(tokenize): correct capture group reference in website regex - [#1004](https://github.com/livekit/agents-js/pull/1004) ([@IlyaShelestov](https://github.com/IlyaShelestov))

## 1.0.39

### Patch Changes

- update livekit inference model to match latest - [#993](https://github.com/livekit/agents-js/pull/993) ([@davidzhao](https://github.com/davidzhao))

- preserve thought_signature across parallel tool calls for Gemini 3+ for inference gateway - [#1000](https://github.com/livekit/agents-js/pull/1000) ([@toubatbrian](https://github.com/toubatbrian))

- Make agent state transition fixes and add interim transcript interruption support - [#992](https://github.com/livekit/agents-js/pull/992) ([@toubatbrian](https://github.com/toubatbrian))

- fix: handle VAD stream closed error during agent handover - [#997](https://github.com/livekit/agents-js/pull/997) ([@toubatbrian](https://github.com/toubatbrian))

  - Fixed a race condition in `StreamAdapter` where `endInput()` could be called on an already-closed VAD stream during agent handover, causing an unrecoverable `stt_error`. This affected non-streaming STTs (like OpenAI STT) that use the StreamAdapter wrapper.
  - Added `isStreamClosedError()` utility function for consistent error handling.
  - Upgraded sharp from 0.34.3 to 0.34.5 to fix libvips version conflict (1.2.0 vs 1.2.4) that caused flaky agent behavior and ObjC class collision warnings on macOS.
  - Fixed pre-existing build error in test plugin (Int16Array to ArrayBuffer conversion).

## 1.0.38

### Patch Changes

- Add support for noiseCancellation frameProcessors - [#966](https://github.com/livekit/agents-js/pull/966) ([@lukasIO](https://github.com/lukasIO))

- refine timestamps in spans and recording alignment - [#982](https://github.com/livekit/agents-js/pull/982) ([@toubatbrian](https://github.com/toubatbrian))

- Add aligned transcript support with word-level timing for STT plugins - [#984](https://github.com/livekit/agents-js/pull/984) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.37

### Patch Changes

- Add tests for existing agent implementations in examples - [#978](https://github.com/livekit/agents-js/pull/978) ([@toubatbrian](https://github.com/toubatbrian))

- Add advanced test utilities for test framework - [#976](https://github.com/livekit/agents-js/pull/976) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.36

### Patch Changes

- Add connector participant kind to defaults - [#973](https://github.com/livekit/agents-js/pull/973) ([@lukasIO](https://github.com/lukasIO))

- Supports initial set of testing utilities in agent framework - [#965](https://github.com/livekit/agents-js/pull/965) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.35

### Patch Changes

- Fix error logging during shutdown process - [#961](https://github.com/livekit/agents-js/pull/961) ([@Fox32](https://github.com/Fox32))

- Support extra content in inference llm for provider-specific metadata - [#967](https://github.com/livekit/agents-js/pull/967) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.34

### Patch Changes

- Implemented FallbackAdapter for LLM - [#916](https://github.com/livekit/agents-js/pull/916) ([@KrishnaShuk](https://github.com/KrishnaShuk))

- Fix queue closure in LLMStream, STTStream, TTSStream - [#954](https://github.com/livekit/agents-js/pull/954) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.33

### Patch Changes

- Revert "Send all log levels to cloud observability regardless of terminal log level" - [#951](https://github.com/livekit/agents-js/pull/951) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.32

### Patch Changes

- fix(google): handle late-arriving toolCalls in Gemini realtime API - [#937](https://github.com/livekit/agents-js/pull/937) ([@kirsten-emak](https://github.com/kirsten-emak))

  When using the Gemini realtime API, tool calls could occasionally arrive after `turnComplete`, causing them to be lost or trigger errors. This fix keeps the `functionChannel` open after `turnComplete` to catch late-arriving tool calls, and adds a `closed` property to `StreamChannel` to track channel state.

  No code changes required for consumers.

- awaited the prewarm function - [#919](https://github.com/livekit/agents-js/pull/919) ([@KrishnaShuk](https://github.com/KrishnaShuk))

- Fix flaky IPC test EPIPE error - [#941](https://github.com/livekit/agents-js/pull/941) ([@toubatbrian](https://github.com/toubatbrian))

- Send all log levels to cloud observability regardless of terminal log level - [#942](https://github.com/livekit/agents-js/pull/942) ([@toubatbrian](https://github.com/toubatbrian))

- Fix supervisor process crashes when child process dies unexpectedly - [#935](https://github.com/livekit/agents-js/pull/935) ([@Hormold](https://github.com/Hormold))

- inherit execArgv when forking TypeScript child processes - [#948](https://github.com/livekit/agents-js/pull/948) ([@toubatbrian](https://github.com/toubatbrian))

- fix realtime function call timestamps - [#946](https://github.com/livekit/agents-js/pull/946) ([@toubatbrian](https://github.com/toubatbrian))

- Fork files with cjs extension when running cjs file - [#892](https://github.com/livekit/agents-js/pull/892) ([@budde377](https://github.com/budde377))

- fix(agents): return to listening state for Gemini realtime API thinking-only turns - [#936](https://github.com/livekit/agents-js/pull/936) ([@kirsten-emak](https://github.com/kirsten-emak))

## 1.0.31

## 1.0.30

## 1.0.29

### Patch Changes

- Fix voice interruption transcript spill, add ConnectionPool for inference websockets, and log TTS websocket pool misses. - [#910](https://github.com/livekit/agents-js/pull/910) ([@toubatbrian](https://github.com/toubatbrian))

- Support thinking sound inside background audio player - [#915](https://github.com/livekit/agents-js/pull/915) ([@toubatbrian](https://github.com/toubatbrian))

- Support multi-context WebSocket connection for elevenlabs TTS - [#912](https://github.com/livekit/agents-js/pull/912) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.28

## 1.0.27

### Patch Changes

- Sync all package versions - [#900](https://github.com/livekit/agents-js/pull/900) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.26

### Patch Changes

- Fix improper resource cleanup inside AgentActivity by not close global STT / TTS / VAD components - [#893](https://github.com/livekit/agents-js/pull/893) ([@toubatbrian](https://github.com/toubatbrian))

- Improve TTS resource cleanup - [#893](https://github.com/livekit/agents-js/pull/893) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.25

### Patch Changes

- Rename pushedDurationMs to pushedDuration (was actually in seconds) - [#876](https://github.com/livekit/agents-js/pull/876) ([@toubatbrian](https://github.com/toubatbrian))

- Fix improper resource cleanup inside AgentActivity by not close global STT / TTS / VAD components - [#891](https://github.com/livekit/agents-js/pull/891) ([@toubatbrian](https://github.com/toubatbrian))

- Add Session Connection Options and Fix Blocking Speech from High-latency LLM Generation - [#880](https://github.com/livekit/agents-js/pull/880) ([@toubatbrian](https://github.com/toubatbrian))

- Add session shutdown API - [#866](https://github.com/livekit/agents-js/pull/866) ([@toubatbrian](https://github.com/toubatbrian))

- Add traces for `session.say` and `session.generateReply` - [#882](https://github.com/livekit/agents-js/pull/882) ([@toubatbrian](https://github.com/toubatbrian))

- Fix error spam during stream cleanup. Gracefully handle edge cases when detaching audio streams that were never initialized. - [#884](https://github.com/livekit/agents-js/pull/884) ([@Hormold](https://github.com/Hormold))

- Add RecorderIO for stereo audio recording - [#876](https://github.com/livekit/agents-js/pull/876) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.24

### Patch Changes

- Unset record flag by default in agent session - [#878](https://github.com/livekit/agents-js/pull/878) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.23

### Patch Changes

- Support transcripts & traces upload to livekit cloud observability - [#863](https://github.com/livekit/agents-js/pull/863) ([@toubatbrian](https://github.com/toubatbrian))

- Fixed memory leaks in AgentActivity and AgentSession - [#875](https://github.com/livekit/agents-js/pull/875) ([@jessebond2](https://github.com/jessebond2))

- Support otel traces upload to livekit cloud observability - [#867](https://github.com/livekit/agents-js/pull/867) ([@toubatbrian](https://github.com/toubatbrian))

- Support logging integration to livekit cloud observability - [#873](https://github.com/livekit/agents-js/pull/873) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.22

### Patch Changes

- Fix race condition where STT/TTS processing could throw "Queue is closed" error when a participant disconnects. These events are now logged as warnings instead of errors. - [#861](https://github.com/livekit/agents-js/pull/861) ([@Devesh36](https://github.com/Devesh36))

- Fix TTS with proper error handling logics from expected shutdown / interruptions - [#859](https://github.com/livekit/agents-js/pull/859) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.21

### Patch Changes

- create a new error object on timeout to have a correct stacktrace - [#853](https://github.com/livekit/agents-js/pull/853) ([@simllll](https://github.com/simllll))

- Fix memory leak of inference gateway STT provider - [#858](https://github.com/livekit/agents-js/pull/858) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.20

### Patch Changes

- fix resource cleanup - [#849](https://github.com/livekit/agents-js/pull/849) ([@simllll](https://github.com/simllll))

- fix await supportslangauge - [#850](https://github.com/livekit/agents-js/pull/850) ([@simllll](https://github.com/simllll))

## 1.0.19

### Patch Changes

- Added SessionReport and onSessionEnd callback - [#811](https://github.com/livekit/agents-js/pull/811) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.18

### Patch Changes

- bump openai to 6.x - [#813](https://github.com/livekit/agents-js/pull/813) ([@toubatbrian](https://github.com/toubatbrian))

- Emit away events for User - [#801](https://github.com/livekit/agents-js/pull/801) ([@paulheinrichs-jb](https://github.com/paulheinrichs-jb))

- Support openai half-duplex mode (audio in -> text out -> custom TTS model) - [#814](https://github.com/livekit/agents-js/pull/814) ([@toubatbrian](https://github.com/toubatbrian))

- Support strict tool schema for openai-competible model - [#816](https://github.com/livekit/agents-js/pull/816) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.17

### Patch Changes

- handle APIError in STT & TTS retry mechanism and prevent ERR_UNHANDLED_ERROR - [#804](https://github.com/livekit/agents-js/pull/804) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.16

### Patch Changes

- Add preemptive generation - [#798](https://github.com/livekit/agents-js/pull/798) ([@toubatbrian](https://github.com/toubatbrian))

- Rename Worker to AgentServer - [#713](https://github.com/livekit/agents-js/pull/713) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 1.0.15

### Patch Changes

- Fix race condition causing "Writer is not bound to a WritableStream" error in Silero VAD - [#786](https://github.com/livekit/agents-js/pull/786) ([@toubatbrian](https://github.com/toubatbrian))

- Support Zod V4 tool schema and backward competible to V3 - [#792](https://github.com/livekit/agents-js/pull/792) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.14

### Patch Changes

- Fix ffmpeg dependency cannot found issue - [#793](https://github.com/livekit/agents-js/pull/793) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.13

### Patch Changes

- Add utility to play local audio file to livekit - [#788](https://github.com/livekit/agents-js/pull/788) ([@toubatbrian](https://github.com/toubatbrian))

- Add BackgroundAudio support - [#789](https://github.com/livekit/agents-js/pull/789) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.12

### Patch Changes

- Expose EOUMetrics type - [#776](https://github.com/livekit/agents-js/pull/776) ([@toubatbrian](https://github.com/toubatbrian))

- - Fix CommonJS entrypoint to resolve files from `dist` - [#777](https://github.com/livekit/agents-js/pull/777) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.11

### Patch Changes

- Convert and rename all time-based metric fields to \*Ms variants - [#765](https://github.com/livekit/agents-js/pull/765) ([@toubatbrian](https://github.com/toubatbrian))

- Add comment on units for LLM metrics - [#764](https://github.com/livekit/agents-js/pull/764) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- Support custom text callback - [#761](https://github.com/livekit/agents-js/pull/761) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.10

### Patch Changes

- Ensure tool calls are not aborted when preamble text forwarding stops. It refines the execution flow so that cleanup of preamble forwarders does not propagate an abort to in-flight tool executions. - [#756](https://github.com/livekit/agents-js/pull/756) ([@jjsquillante](https://github.com/jjsquillante))

## 1.0.9

### Patch Changes

- Wait for all speech playouts inside tool before tool reply in realtime model - [#753](https://github.com/livekit/agents-js/pull/753) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.8

### Patch Changes

- Fix inference gateway LLM to allow not passing OPENAI_API_KEY - [#743](https://github.com/livekit/agents-js/pull/743) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.7

### Patch Changes

- Support using 'lang/\*' format for defining gateway STT - [#728](https://github.com/livekit/agents-js/pull/728) ([@toubatbrian](https://github.com/toubatbrian))

- Update LLM inference gateway model names - [#742](https://github.com/livekit/agents-js/pull/742) ([@toubatbrian](https://github.com/toubatbrian))

- update comments on room io configs - [#739](https://github.com/livekit/agents-js/pull/739) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- fix docstrings - [#740](https://github.com/livekit/agents-js/pull/740) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- update UserInputTranscribedEvent with language - [#741](https://github.com/livekit/agents-js/pull/741) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- Add LiveKit gateway model integrations - [#734](https://github.com/livekit/agents-js/pull/734) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.6

### Patch Changes

- add logs for tracks on participant - [#721](https://github.com/livekit/agents-js/pull/721) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 1.0.5

### Patch Changes

- add some logging to debug track not being subscribed - [#708](https://github.com/livekit/agents-js/pull/708) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 1.0.4

### Patch Changes

- Add avatar datastream io component - [#687](https://github.com/livekit/agents-js/pull/687) ([@toubatbrian](https://github.com/toubatbrian))

- bugfix: agent not recieving audio from room sometimes - [#705](https://github.com/livekit/agents-js/pull/705) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- refactor speech handle to allow waiting for playout in tool calls - [#693](https://github.com/livekit/agents-js/pull/693) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 1.0.3

### Patch Changes

- Remove requirement to call ctx.connect in entrypoint function - [#689](https://github.com/livekit/agents-js/pull/689) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- Fix agent session race condition by always waiting for activity to start - [#688](https://github.com/livekit/agents-js/pull/688) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.2

### Patch Changes

- Fix Job memory monitoring. - [#676](https://github.com/livekit/agents-js/pull/676) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- Fix issues with splicing arrays and memory watch interval - [#670](https://github.com/livekit/agents-js/pull/670) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- fix division by zero errors - [#674](https://github.com/livekit/agents-js/pull/674) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- bugfix with setting sample rate - [#672](https://github.com/livekit/agents-js/pull/672) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- bugfix with inferenceDurationTotal accumulation on inference done - [#671](https://github.com/livekit/agents-js/pull/671) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- bugfix in uuid generation for inference process - [#675](https://github.com/livekit/agents-js/pull/675) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 1.0.1

### Patch Changes

- fix sharpe package version - [#661](https://github.com/livekit/agents-js/pull/661) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 1.0.0

### Major Changes

- Release @livekit/agents and all plugins to version 1.0.0 - [#626](https://github.com/livekit/agents-js/pull/626) ([@toubatbrian](https://github.com/toubatbrian))

### Patch Changes

- fix: set correct attribute name for transcription_final - [#589](https://github.com/livekit/agents-js/pull/589) ([@lukasIO](https://github.com/lukasIO))

- Fix monorepo dependencies - [#634](https://github.com/livekit/agents-js/pull/634) ([@lukasIO](https://github.com/lukasIO))

- fix ctrl c logs - [#656](https://github.com/livekit/agents-js/pull/656) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- fix google LLM and gemini realtime - [#646](https://github.com/livekit/agents-js/pull/646) ([@toubatbrian](https://github.com/toubatbrian))

- pin onnxruntime to 1.21.1 - [#639](https://github.com/livekit/agents-js/pull/639) ([@toubatbrian](https://github.com/toubatbrian))

- update logs - [#643](https://github.com/livekit/agents-js/pull/643) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- Remove @jsr dependencies - [#630](https://github.com/livekit/agents-js/pull/630) ([@lukasIO](https://github.com/lukasIO))

- fix: avoid masquerading types as mjs - [#434](https://github.com/livekit/agents-js/pull/434) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- pin onnxruntime to be 1.21.0 aligned with deps in huggingface transformers.js - [#638](https://github.com/livekit/agents-js/pull/638) ([@toubatbrian](https://github.com/toubatbrian))

- fix nuphonic plugin - [#645](https://github.com/livekit/agents-js/pull/645) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 1.0.0-next.7

### Patch Changes

- fix ctrl c logs - [#656](https://github.com/livekit/agents-js/pull/656) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 1.0.0-next.6

### Patch Changes

- fix google LLM and gemini realtime - [#646](https://github.com/livekit/agents-js/pull/646) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.0-next.5

### Patch Changes

- update logs - [#643](https://github.com/livekit/agents-js/pull/643) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- fix nuphonic plugin - [#645](https://github.com/livekit/agents-js/pull/645) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 1.0.0-next.4

### Patch Changes

- pin onnxruntime to 1.21.1 - [#639](https://github.com/livekit/agents-js/pull/639) ([@toubatbrian](https://github.com/toubatbrian))

## 1.0.0-next.3

### Patch Changes

- pin onnxruntime to be 1.21.0 aligned with deps in huggingface transformers.js

## 1.0.0-next.2

### Patch Changes

- Fix monorepo dependencies - [#634](https://github.com/livekit/agents-js/pull/634) ([@lukasIO](https://github.com/lukasIO))

## 1.0.0-next.1

### Patch Changes

- Remove @jsr dependencies - [`9876876fa53c818fc3bef5e707baf5ff3c74262a`](https://github.com/livekit/agents-js/commit/9876876fa53c818fc3bef5e707baf5ff3c74262a) ([@lukasIO](https://github.com/lukasIO))

## 1.0.0-next.0

### Major Changes

- Release @livekit/agents and all plugins to version 1.0.0 - [#626](https://github.com/livekit/agents-js/pull/626) ([@toubatbrian](https://github.com/toubatbrian))

### Patch Changes

- fix: set correct attribute name for transcription_final - [#589](https://github.com/livekit/agents-js/pull/589) ([@lukasIO](https://github.com/lukasIO))

- fix: avoid masquerading types as mjs - [#434](https://github.com/livekit/agents-js/pull/434) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 0.7.6

### Patch Changes

- fix memory leak when job completed - [#418](https://github.com/livekit/agents-js/pull/418) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 0.7.5

### Patch Changes

- cleanup resources with onnx runtime - [#377](https://github.com/livekit/agents-js/pull/377) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- upgrade livekit rtc version - [#384](https://github.com/livekit/agents-js/pull/384) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 0.7.4

### Patch Changes

- bugfix: don't wait to queue audio frames before they are sent to the room - [#371](https://github.com/livekit/agents-js/pull/371) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- Publish transcriptions additionally via text stream APIs - [#348](https://github.com/livekit/agents-js/pull/348) ([@lukasIO](https://github.com/lukasIO))

- clean up job processes correctly - [#376](https://github.com/livekit/agents-js/pull/376) ([@Shubhrakanti](https://github.com/Shubhrakanti))

## 0.7.3

### Patch Changes

- add inbound noise cancellation support - [#358](https://github.com/livekit/agents-js/pull/358) ([@typester](https://github.com/typester))

- fix(worker): default healthcheck to listen on 0 - [#363](https://github.com/livekit/agents-js/pull/363) ([@nbsp](https://github.com/nbsp))

## 0.7.2

### Patch Changes

- fix: fix race condition in TextAudioSynchronizer causing "TextAudioSynchronizer is closed" errors in AgentPlayout - [#342](https://github.com/livekit/agents-js/pull/342) ([@xavierroma](https://github.com/xavierroma))

- fix(worker): reconnect on severed websocket conn - [#332](https://github.com/livekit/agents-js/pull/332) ([@nbsp](https://github.com/nbsp))

- update logging when processes exist - [#353](https://github.com/livekit/agents-js/pull/353) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- add worker endpoint for hosted agents - [#350](https://github.com/livekit/agents-js/pull/350) ([@paulwe](https://github.com/paulwe))

## 0.7.1

### Patch Changes

- fix(proc): ignore SIGTERM as well as SIGINT - [#328](https://github.com/livekit/agents-js/pull/328) ([@nbsp](https://github.com/nbsp))

- log unhandled promise rejections - [#325](https://github.com/livekit/agents-js/pull/325) ([@nbsp](https://github.com/nbsp))

- fix(multimodal): ensure audio samples is never smaller than 0 - [#319](https://github.com/livekit/agents-js/pull/319) ([@lukasIO](https://github.com/lukasIO))

- fix(pipeline): don't mark segment end if cancelled - [#326](https://github.com/livekit/agents-js/pull/326) ([@nbsp](https://github.com/nbsp))

## 0.7.0

### Minor Changes

- feat: add turn detector - [#225](https://github.com/livekit/agents-js/pull/225) ([@nbsp](https://github.com/nbsp))

### Patch Changes

- replace transcription forwarder with synchronizer - [#301](https://github.com/livekit/agents-js/pull/301) ([@nbsp](https://github.com/nbsp))

- fix(stt): gracefully fail on StreamAdapter errors - [#299](https://github.com/livekit/agents-js/pull/299) ([@nbsp](https://github.com/nbsp))

- skip TTS on empty LLM output - [#293](https://github.com/livekit/agents-js/pull/293) ([@jheising](https://github.com/jheising))

- fix(worker): clearer timeout handling for drain - [#277](https://github.com/livekit/agents-js/pull/277) ([@nbsp](https://github.com/nbsp))

- fix feeding null LLM input - [#296](https://github.com/livekit/agents-js/pull/296) ([@nbsp](https://github.com/nbsp))

## 0.6.4

### Patch Changes

- fix(proc): clearer errors on crash - [#271](https://github.com/livekit/agents-js/pull/271) ([@nbsp](https://github.com/nbsp))

- fix(metrics): remove ErrorOptions from MultimodalError - [#278](https://github.com/livekit/agents-js/pull/278) ([@nbsp](https://github.com/nbsp))

## 0.6.3

### Patch Changes

- fix LLM retries breaking on VoicePipelineAgent - [#265](https://github.com/livekit/agents-js/pull/265) ([@nbsp](https://github.com/nbsp))

## 0.6.2

### Patch Changes

- fix(pipeline): double LLM replies - [#259](https://github.com/livekit/agents-js/pull/259) ([@nbsp](https://github.com/nbsp))

- update rtc-node to 0.13.2 to fix issue with e2ee - [#258](https://github.com/livekit/agents-js/pull/258) ([@nbsp](https://github.com/nbsp))

## 0.6.1

### Patch Changes

- remove incorrect !-assertion in queue implementation leading to race conditions - [#240](https://github.com/livekit/agents-js/pull/240) ([@nbsp](https://github.com/nbsp))

- chore(bump): rtc-node -> 0.13.1 - [#247](https://github.com/livekit/agents-js/pull/247) ([@nbsp](https://github.com/nbsp))

- re-request audio response in multimodal agent when text is given - [#243](https://github.com/livekit/agents-js/pull/243) ([@nbsp](https://github.com/nbsp))

## 0.6.0

### Minor Changes

- MultimodalAgent: emit user started speaking event - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

- support nested speech handles in pipeline agent - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

- add metrics monitoring - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

### Patch Changes

- Allow attributes to be set on accept - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

- fix(multimodal): crash on reconnect to same room - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

- fix tokenizer - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

- fix(pipeline): add transcription for AGENT_SPEECH_COMMITTED - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

- add testutils, tests for oai, 11labs - [#227](https://github.com/livekit/agents-js/pull/227) ([@nbsp](https://github.com/nbsp))

## 0.5.2

### Patch Changes

- fix(pipeline): add transcription for AGENT_SPEECH_COMMITTED - [#219](https://github.com/livekit/agents-js/pull/219) ([@nbsp](https://github.com/nbsp))

## 0.5.1

### Patch Changes

- Allow attributes to be set on accept - [#198](https://github.com/livekit/agents-js/pull/198) ([@nbsp](https://github.com/nbsp))

- fix tokenizer - [#206](https://github.com/livekit/agents-js/pull/206) ([@nbsp](https://github.com/nbsp))

- add testutils, tests for oai, 11labs - [#206](https://github.com/livekit/agents-js/pull/206) ([@nbsp](https://github.com/nbsp))

## 0.5.0

### Minor Changes

- support native CommonJS - [#187](https://github.com/livekit/agents-js/pull/187) ([@nbsp](https://github.com/nbsp))

### Patch Changes

- proper checks for `allowInterruptions` flag before attempting interruption - [#187](https://github.com/livekit/agents-js/pull/187) ([@nbsp](https://github.com/nbsp))

- chore(treewide): add READMEs for npmjs.com - [#187](https://github.com/livekit/agents-js/pull/187) ([@nbsp](https://github.com/nbsp))

## 0.4.6

### Patch Changes

- Add missing package info - [#172](https://github.com/livekit/agents-js/pull/172) ([@lukasIO](https://github.com/lukasIO))

- feat(multimodal): add speech committed events - [#169](https://github.com/livekit/agents-js/pull/169) ([@nbsp](https://github.com/nbsp))

- correct pipeline agent state attribute name - [#175](https://github.com/livekit/agents-js/pull/175) ([@john-royal](https://github.com/john-royal))

- fix: correct pipeline agent state attribute name - [#175](https://github.com/livekit/agents-js/pull/175) ([@john-royal](https://github.com/john-royal))

## 0.4.5

### Patch Changes

- Use peer dependencies for @livekit/rtc-node and @livekit/agents - [#170](https://github.com/livekit/agents-js/pull/170) ([@lukasIO](https://github.com/lukasIO))

- Ensure llm string conversation safely accesses content - [#166](https://github.com/livekit/agents-js/pull/166) ([@gching](https://github.com/gching))

- chore(tsconfig): enable `noUncheckedIndexedAccess` - [#168](https://github.com/livekit/agents-js/pull/168) ([@nbsp](https://github.com/nbsp))

- Ensure token stream flushes - [#167](https://github.com/livekit/agents-js/pull/167) ([@gching](https://github.com/gching))

- feat(openai): allow raw JSON function parameters - [#146](https://github.com/livekit/agents-js/pull/146) ([@nbsp](https://github.com/nbsp))

## 0.4.4

### Patch Changes

- add ChunkedStream, openai.TTS - [#155](https://github.com/livekit/agents-js/pull/155) ([@nbsp](https://github.com/nbsp))

- feat(stt): implement StreamAdapter - [#156](https://github.com/livekit/agents-js/pull/156) ([@nbsp](https://github.com/nbsp))

- export VPAEvent not as type - [#161](https://github.com/livekit/agents-js/pull/161) ([@nbsp](https://github.com/nbsp))

- add tts.StreamAdapter - [#156](https://github.com/livekit/agents-js/pull/156) ([@nbsp](https://github.com/nbsp))

## 0.4.3

## 0.4.2

### Patch Changes

- fix ESM interop - [#145](https://github.com/livekit/agents-js/pull/145) ([@nbsp](https://github.com/nbsp))

## 0.4.1

### Patch Changes

- fix(proc): behave correctly on numIdleProcesses: 0 - [#142](https://github.com/livekit/agents-js/pull/142) ([@nbsp](https://github.com/nbsp))

## 0.4.0

### Minor Changes

- OpenAI function calling: support arrays and optional fields in function call schema - [#140](https://github.com/livekit/agents-js/pull/140) ([@nbsp](https://github.com/nbsp))

- add basic tokenizer implementations - [#140](https://github.com/livekit/agents-js/pull/140) ([@nbsp](https://github.com/nbsp))

- add VoicePipelineAgent - [#138](https://github.com/livekit/agents-js/pull/138) ([@nbsp](https://github.com/nbsp))

- add LLM and LLMStream baseclasses - [#140](https://github.com/livekit/agents-js/pull/140) ([@nbsp](https://github.com/nbsp))

- add ChatContext - [#140](https://github.com/livekit/agents-js/pull/140) ([@nbsp](https://github.com/nbsp))

- update TTS and STT baseclasses to match python - [#140](https://github.com/livekit/agents-js/pull/140) ([@nbsp](https://github.com/nbsp))

### Patch Changes

- make numIdleProcesses work - [#135](https://github.com/livekit/agents-js/pull/135) ([@nbsp](https://github.com/nbsp))

- re-add ElevenLabs TTS plugin - [#140](https://github.com/livekit/agents-js/pull/140) ([@nbsp](https://github.com/nbsp))

- add Deepgram text-to-speech plugin - [#140](https://github.com/livekit/agents-js/pull/140) ([@nbsp](https://github.com/nbsp))

- throw an error when using CommonJS with tsx - [#139](https://github.com/livekit/agents-js/pull/139) ([@nbsp](https://github.com/nbsp))

- add OpenAI LLM - [#140](https://github.com/livekit/agents-js/pull/140) ([@nbsp](https://github.com/nbsp))

- add Silero VAD, overhaul VAD class - [#140](https://github.com/livekit/agents-js/pull/140) ([@nbsp](https://github.com/nbsp))

## 0.3.5

### Patch Changes

- fix(treewide): use newer rtc-node version - [#118](https://github.com/livekit/agents-js/pull/118) ([@nbsp](https://github.com/nbsp))

- Subscribe to published mic track for linked participant only - [#123](https://github.com/livekit/agents-js/pull/123) ([@bcherry](https://github.com/bcherry))

- Update everything to rtc 0.11.0 - [#125](https://github.com/livekit/agents-js/pull/125) ([@bcherry](https://github.com/bcherry))

## 0.3.4

### Patch Changes

- fix issue wherein sometimes job processes would hang on CLI help - [#114](https://github.com/livekit/agents-js/pull/114) ([@nbsp](https://github.com/nbsp))

- Use shared mutex helper lib - [#112](https://github.com/livekit/agents-js/pull/112) ([@lukasIO](https://github.com/lukasIO))

## 0.3.3

### Patch Changes

- Fix subscription timing - [#110](https://github.com/livekit/agents-js/pull/110) ([@nbsp](https://github.com/nbsp))

- fix usage on Windows by importing using URLs, not paths - [#110](https://github.com/livekit/agents-js/pull/110) ([@nbsp](https://github.com/nbsp))

## 0.3.2

### Patch Changes

- A few more bugs and updates - [#88](https://github.com/livekit/agents-js/pull/88) ([@bcherry](https://github.com/bcherry))

- allow writing userData - [#90](https://github.com/livekit/agents-js/pull/90) ([@nbsp](https://github.com/nbsp))

## 0.3.1

### Patch Changes

- standardize logging - [#78](https://github.com/livekit/agents-js/pull/78) ([@nbsp](https://github.com/nbsp))

- audit uses of ! - [#77](https://github.com/livekit/agents-js/pull/77) ([@nbsp](https://github.com/nbsp))

- Fix the done property on Future - [#83](https://github.com/livekit/agents-js/pull/83) ([@bcherry](https://github.com/bcherry))

- make sure rejects return errors, not string - [#84](https://github.com/livekit/agents-js/pull/84) ([@nbsp](https://github.com/nbsp))

- multimodal: reject on start if already started - [#82](https://github.com/livekit/agents-js/pull/82) ([@nbsp](https://github.com/nbsp))

## 0.3.0

### Minor Changes

- Rename to MultimodalAgent, move to main package - [#74](https://github.com/livekit/agents-js/pull/74) ([@bcherry](https://github.com/bcherry))

- add waitForParticipant - [#73](https://github.com/livekit/agents-js/pull/73) ([@nbsp](https://github.com/nbsp))

- omniassistant overhaul - [#65](https://github.com/livekit/agents-js/pull/65) ([@nbsp](https://github.com/nbsp))

### Patch Changes

- update rtc-node to 0.9.0 - [#73](https://github.com/livekit/agents-js/pull/73) ([@nbsp](https://github.com/nbsp))

- improve dev mode default parameters - [#70](https://github.com/livekit/agents-js/pull/70) ([@nbsp](https://github.com/nbsp))

- throw friendly error on --participant-identity err - [#61](https://github.com/livekit/agents-js/pull/61) ([@nbsp](https://github.com/nbsp))

- shut everything down correctly - [#62](https://github.com/livekit/agents-js/pull/62) ([@nbsp](https://github.com/nbsp))

- Maximize self-import compatibility - [#69](https://github.com/livekit/agents-js/pull/69) ([@bcherry](https://github.com/bcherry))

- automatically no-op on CLI if executor is job_main - [#64](https://github.com/livekit/agents-js/pull/64) ([@nbsp](https://github.com/nbsp))

- Allow passing required params in WorkerOptions - [#68](https://github.com/livekit/agents-js/pull/68) ([@bcherry](https://github.com/bcherry))

## 0.2.0

### Minor Changes

- bump underlying dependencies - [`be7160d39ea57239a51fbf6ad2cbea1342cc1889`](https://github.com/livekit/agents-js/commit/be7160d39ea57239a51fbf6ad2cbea1342cc1889) ([@bcherry](https://github.com/bcherry))
  fix load calculation
  report worker status

- cli: add runHeadless function - [`36c553a60fef7621b9c4232b5c79555b2f83aad8`](https://github.com/livekit/agents-js/commit/36c553a60fef7621b9c4232b5c79555b2f83aad8) ([@nbsp](https://github.com/nbsp))

### Patch Changes

- worker: JT\_{PUBLISHER => ROOM} - [`1c8caf04c148dfa57af4e844b6538d97d6be652a`](https://github.com/livekit/agents-js/commit/1c8caf04c148dfa57af4e844b6538d97d6be652a) ([@nbsp](https://github.com/nbsp))

- Pass api key and secret to RoomServiceClient - [#58](https://github.com/livekit/agents-js/pull/58) ([@bcherry](https://github.com/bcherry))

- Let defineAgent accept agent type - [`24a4f58a23d4a3aad8620fcccabdab5d2e1152c7`](https://github.com/livekit/agents-js/commit/24a4f58a23d4a3aad8620fcccabdab5d2e1152c7) ([@lukasIO](https://github.com/lukasIO))

- Add transcript support to realtime voice assistant - [`1063d2a25c4a01022948699e673d267d04c1ec05`](https://github.com/livekit/agents-js/commit/1063d2a25c4a01022948699e673d267d04c1ec05) ([@bcherry](https://github.com/bcherry))
