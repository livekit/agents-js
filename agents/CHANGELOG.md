# @livekit/agents

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
