# @livekit/agents

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
