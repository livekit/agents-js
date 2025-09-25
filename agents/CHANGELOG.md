# @livekit/agents

## 1.1.0

### Minor Changes

- Add LiveKit gateway model integrations - [#694](https://github.com/livekit/agents-js/pull/694) ([@toubatbrian](https://github.com/toubatbrian))

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
