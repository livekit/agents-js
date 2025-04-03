# @livekit/agents

## 0.7.2

### Patch Changes

- fix(worker): reconnect on severed websocket conn - [#332](https://github.com/livekit/agents-js/pull/332) ([@nbsp](https://github.com/nbsp))

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
