# @livekit/agents-plugin-google

## 1.0.33

### Patch Changes

- Updated dependencies [[`66aceb44fc8dae016566d8ca1c5d0d1adc66820a`](https://github.com/livekit/agents-js/commit/66aceb44fc8dae016566d8ca1c5d0d1adc66820a)]:
  - @livekit/agents@1.0.33

## 1.0.32

### Patch Changes

- fix(google): handle late-arriving toolCalls in Gemini realtime API - [#937](https://github.com/livekit/agents-js/pull/937) ([@kirsten-emak](https://github.com/kirsten-emak))

  When using the Gemini realtime API, tool calls could occasionally arrive after `turnComplete`, causing them to be lost or trigger errors. This fix keeps the `functionChannel` open after `turnComplete` to catch late-arriving tool calls, and adds a `closed` property to `StreamChannel` to track channel state.

  No code changes required for consumers.

- Add gemini realtime API thinking config - [#950](https://github.com/livekit/agents-js/pull/950) ([@Speediing](https://github.com/Speediing))

- fix realtime function call timestamps - [#946](https://github.com/livekit/agents-js/pull/946) ([@toubatbrian](https://github.com/toubatbrian))

- Update Gemini realtime models and voices to match latest API - [#940](https://github.com/livekit/agents-js/pull/940) ([@toubatbrian](https://github.com/toubatbrian))

- Skip streaming thought tokens from gemini realtime thinking model - [#943](https://github.com/livekit/agents-js/pull/943) ([@toubatbrian](https://github.com/toubatbrian))

- preserve thought signatures for Gemini 3+ function calling - [#921](https://github.com/livekit/agents-js/pull/921) ([@tomc98](https://github.com/tomc98))

- Updated dependencies [[`42fe53b88746baa71c80ab9b29fdf7a311cf266b`](https://github.com/livekit/agents-js/commit/42fe53b88746baa71c80ab9b29fdf7a311cf266b), [`79664cc302938e73589f32037f87f50f894a3057`](https://github.com/livekit/agents-js/commit/79664cc302938e73589f32037f87f50f894a3057), [`3b8fcd7b624642cf9d5331d0a209d7c2deba5dae`](https://github.com/livekit/agents-js/commit/3b8fcd7b624642cf9d5331d0a209d7c2deba5dae), [`0ff2d1a29737de4a842006ad88431f4978010bbc`](https://github.com/livekit/agents-js/commit/0ff2d1a29737de4a842006ad88431f4978010bbc), [`1fa10e11d7d1d8c781df52e8d1ddfede7bc27b42`](https://github.com/livekit/agents-js/commit/1fa10e11d7d1d8c781df52e8d1ddfede7bc27b42), [`3aaa8286c631da734d51a6e42217083be50f9568`](https://github.com/livekit/agents-js/commit/3aaa8286c631da734d51a6e42217083be50f9568), [`62e397b34367dab24b427b1a813ee525a98f0438`](https://github.com/livekit/agents-js/commit/62e397b34367dab24b427b1a813ee525a98f0438), [`0459da7663e553eef3aa58689f35bd1c0a756cb0`](https://github.com/livekit/agents-js/commit/0459da7663e553eef3aa58689f35bd1c0a756cb0), [`710688b9424b41d90c99ee0dc8e530a101d32526`](https://github.com/livekit/agents-js/commit/710688b9424b41d90c99ee0dc8e530a101d32526)]:
  - @livekit/agents@1.0.32

## 1.0.31

### Patch Changes

- Updated dependencies []:
  - @livekit/agents@1.0.31

## 1.0.30

### Patch Changes

- Updated dependencies []:
  - @livekit/agents@1.0.30

## 1.0.29

### Patch Changes

- Support thinking sound inside background audio player - [#915](https://github.com/livekit/agents-js/pull/915) ([@toubatbrian](https://github.com/toubatbrian))

- Updated dependencies [[`6eeba4a36b13f7b7817bcc328d5d61f60a20312d`](https://github.com/livekit/agents-js/commit/6eeba4a36b13f7b7817bcc328d5d61f60a20312d), [`6115277e6ebfaba8df713cf1125b3bac9f4ba669`](https://github.com/livekit/agents-js/commit/6115277e6ebfaba8df713cf1125b3bac9f4ba669), [`f3d33453976d6447ebdf22f9d2d8783df76d7562`](https://github.com/livekit/agents-js/commit/f3d33453976d6447ebdf22f9d2d8783df76d7562)]:
  - @livekit/agents@1.0.29

## 1.0.28

### Patch Changes

- Updated dependencies []:
  - @livekit/agents@1.0.28

## 1.0.27

### Patch Changes

- Sync all package versions - [#900](https://github.com/livekit/agents-js/pull/900) ([@toubatbrian](https://github.com/toubatbrian))

- Updated dependencies [[`714c1a9f73d03a83ee25f7b6d3bd6727070030ae`](https://github.com/livekit/agents-js/commit/714c1a9f73d03a83ee25f7b6d3bd6727070030ae)]:
  - @livekit/agents@1.0.27

## 1.0.26

### Patch Changes

- Improve TTS resource cleanup - [#893](https://github.com/livekit/agents-js/pull/893) ([@toubatbrian](https://github.com/toubatbrian))

- Updated dependencies [[`78a0d217b783c9467e68c24752d01b9c806b9280`](https://github.com/livekit/agents-js/commit/78a0d217b783c9467e68c24752d01b9c806b9280), [`78a0d217b783c9467e68c24752d01b9c806b9280`](https://github.com/livekit/agents-js/commit/78a0d217b783c9467e68c24752d01b9c806b9280)]:
  - @livekit/agents@1.0.26

## 1.0.25

### Patch Changes

- Updated dependencies [[`6b94d1a1b50d3a4e96443b21979ddad415ac7b6e`](https://github.com/livekit/agents-js/commit/6b94d1a1b50d3a4e96443b21979ddad415ac7b6e), [`e590012fda5a32e86c183d06d9ff5a5810ad688a`](https://github.com/livekit/agents-js/commit/e590012fda5a32e86c183d06d9ff5a5810ad688a), [`40aa678d7cbd63b97215ced99e700b286c971ff0`](https://github.com/livekit/agents-js/commit/40aa678d7cbd63b97215ced99e700b286c971ff0), [`3a0872e730179fe1dbcc3a446d92480611270992`](https://github.com/livekit/agents-js/commit/3a0872e730179fe1dbcc3a446d92480611270992), [`c7ea84ec3ee9cd132b8e3a7bd7cca3040ae420dc`](https://github.com/livekit/agents-js/commit/c7ea84ec3ee9cd132b8e3a7bd7cca3040ae420dc), [`a21eb72d7ca452489353ef42f8e2922d2b6047a2`](https://github.com/livekit/agents-js/commit/a21eb72d7ca452489353ef42f8e2922d2b6047a2), [`6b94d1a1b50d3a4e96443b21979ddad415ac7b6e`](https://github.com/livekit/agents-js/commit/6b94d1a1b50d3a4e96443b21979ddad415ac7b6e)]:
  - @livekit/agents@1.0.25

## 1.0.24

### Patch Changes

- Updated dependencies [[`a1f71249c9d5106481d4a4635218917f46029d0f`](https://github.com/livekit/agents-js/commit/a1f71249c9d5106481d4a4635218917f46029d0f)]:
  - @livekit/agents@1.0.24

## 1.0.23

### Patch Changes

- Updated dependencies [[`33ca7ad3bef1c941988667b95f7f8b908182cef9`](https://github.com/livekit/agents-js/commit/33ca7ad3bef1c941988667b95f7f8b908182cef9), [`b1ba4de94c48b520f145e9f6805ed1f0f64630e5`](https://github.com/livekit/agents-js/commit/b1ba4de94c48b520f145e9f6805ed1f0f64630e5), [`97d066fbcd6bbc525567dbb68c5ce1e8e3755ac6`](https://github.com/livekit/agents-js/commit/97d066fbcd6bbc525567dbb68c5ce1e8e3755ac6), [`705b88690d3949b84b95677f324f3afa52a557df`](https://github.com/livekit/agents-js/commit/705b88690d3949b84b95677f324f3afa52a557df)]:
  - @livekit/agents@1.0.23

## 1.0.22

### Patch Changes

- Updated dependencies [[`aed026cfb2109ae6df5624f855b51e1023f87934`](https://github.com/livekit/agents-js/commit/aed026cfb2109ae6df5624f855b51e1023f87934), [`b4f2392f720498f355e1f535eb14b9c79229244b`](https://github.com/livekit/agents-js/commit/b4f2392f720498f355e1f535eb14b9c79229244b)]:
  - @livekit/agents@1.0.22

## 1.0.21

### Patch Changes

- Updated dependencies [[`a6d39c6d9201447dab154ea2232bf29c2cc3d681`](https://github.com/livekit/agents-js/commit/a6d39c6d9201447dab154ea2232bf29c2cc3d681), [`4fb96ba83de19360d7d2922eec5dac52ba9a0833`](https://github.com/livekit/agents-js/commit/4fb96ba83de19360d7d2922eec5dac52ba9a0833)]:
  - @livekit/agents@1.0.21

## 1.0.20

### Patch Changes

- Updated dependencies [[`b0f5cce8fcb718eba1a347ed5e66a03a8fd6e281`](https://github.com/livekit/agents-js/commit/b0f5cce8fcb718eba1a347ed5e66a03a8fd6e281), [`01f9ad3b8af8cc485e9f405ec5772c1469e624a3`](https://github.com/livekit/agents-js/commit/01f9ad3b8af8cc485e9f405ec5772c1469e624a3)]:
  - @livekit/agents@1.0.20

## 1.0.19

### Patch Changes

- Fix Google Realtime API missing modalities field on MessageGeneration. This resolves the "Text message received from Realtime API with audio modality" error introduced in version 1.0.18. - [#847](https://github.com/livekit/agents-js/pull/847) ([@toubatbrian](https://github.com/toubatbrian))

- Updated dependencies [[`16020f1c15d33f51cb184298e049b6e037f60b87`](https://github.com/livekit/agents-js/commit/16020f1c15d33f51cb184298e049b6e037f60b87)]:
  - @livekit/agents@1.0.19

## 1.0.18

### Patch Changes

- bump openai to 6.x - [#813](https://github.com/livekit/agents-js/pull/813) ([@toubatbrian](https://github.com/toubatbrian))

- Support openai half-duplex mode (audio in -> text out -> custom TTS model) - [#814](https://github.com/livekit/agents-js/pull/814) ([@toubatbrian](https://github.com/toubatbrian))

- Updated dependencies [[`b10503d62b9b64dfe24f5c79a7e3ef6cc337393d`](https://github.com/livekit/agents-js/commit/b10503d62b9b64dfe24f5c79a7e3ef6cc337393d), [`2335196b0f19404d7094bcdcf2fe1c8bdedfd0d5`](https://github.com/livekit/agents-js/commit/2335196b0f19404d7094bcdcf2fe1c8bdedfd0d5), [`9a58cd39076ae3bb33403c9a512a804ff2cee51e`](https://github.com/livekit/agents-js/commit/9a58cd39076ae3bb33403c9a512a804ff2cee51e), [`21b25dc45cb2271de751ed93a22bff84e1c455a9`](https://github.com/livekit/agents-js/commit/21b25dc45cb2271de751ed93a22bff84e1c455a9)]:
  - @livekit/agents@1.0.18

## 1.0.17

### Patch Changes

- Updated dependencies [[`eb3d6ab46dd533544a59e616a2e0db18e5a10421`](https://github.com/livekit/agents-js/commit/eb3d6ab46dd533544a59e616a2e0db18e5a10421)]:
  - @livekit/agents@1.0.17

## 1.0.16

### Patch Changes

- Updated dependencies [[`c54c21e55f65ec3fbeacf1d3555a21982e914337`](https://github.com/livekit/agents-js/commit/c54c21e55f65ec3fbeacf1d3555a21982e914337), [`ac8214d5e13f53bf68fac5195dd4e01a6d05c4de`](https://github.com/livekit/agents-js/commit/ac8214d5e13f53bf68fac5195dd4e01a6d05c4de)]:
  - @livekit/agents@1.0.16

## 1.0.15

### Patch Changes

- Updated dependencies [[`9cdc59edd0321c69538698eb8b9c129f41728a65`](https://github.com/livekit/agents-js/commit/9cdc59edd0321c69538698eb8b9c129f41728a65), [`9b50d8829ff38d9795f7d8912749cb7fc5b0b2ae`](https://github.com/livekit/agents-js/commit/9b50d8829ff38d9795f7d8912749cb7fc5b0b2ae)]:
  - @livekit/agents@1.0.15

## 1.0.14

### Patch Changes

- Updated dependencies [[`a918f0d640013d90c245752f827ea107841f4f82`](https://github.com/livekit/agents-js/commit/a918f0d640013d90c245752f827ea107841f4f82)]:
  - @livekit/agents@1.0.14

## 1.0.13

### Patch Changes

- Updated dependencies [[`ac1db651e9d313799e0d67642c05dff25ea0d0a5`](https://github.com/livekit/agents-js/commit/ac1db651e9d313799e0d67642c05dff25ea0d0a5), [`e1a5eb333c356f444d57b7382d065ed06f6384f7`](https://github.com/livekit/agents-js/commit/e1a5eb333c356f444d57b7382d065ed06f6384f7)]:
  - @livekit/agents@1.0.13

## 1.0.12

### Patch Changes

- Updated dependencies [[`68d4df42c4be11e0e3dbb5836ff435f30f99396e`](https://github.com/livekit/agents-js/commit/68d4df42c4be11e0e3dbb5836ff435f30f99396e), [`f42b63eb91f56c6f3838a39c86e1d7c1b0150e87`](https://github.com/livekit/agents-js/commit/f42b63eb91f56c6f3838a39c86e1d7c1b0150e87)]:
  - @livekit/agents@1.0.12

## 1.0.11

### Patch Changes

- Convert and rename all time-based metric fields to \*Ms variants - [#765](https://github.com/livekit/agents-js/pull/765) ([@toubatbrian](https://github.com/toubatbrian))

- Updated dependencies [[`5358bb8308ebb350fe0f4f99834772715a9f0e0a`](https://github.com/livekit/agents-js/commit/5358bb8308ebb350fe0f4f99834772715a9f0e0a), [`7817d7964a7babb4dc6ed777ca5476647513b1e3`](https://github.com/livekit/agents-js/commit/7817d7964a7babb4dc6ed777ca5476647513b1e3), [`3549f1a65da3ffc2033ea473540fc1282224a12a`](https://github.com/livekit/agents-js/commit/3549f1a65da3ffc2033ea473540fc1282224a12a)]:
  - @livekit/agents@1.0.11

## 1.0.10

### Patch Changes

- Updated dependencies [[`25b20308cdff0118c0fb07abbf5bb19e1d4be1e3`](https://github.com/livekit/agents-js/commit/25b20308cdff0118c0fb07abbf5bb19e1d4be1e3)]:
  - @livekit/agents@1.0.10

## 1.0.9

### Patch Changes

- Updated dependencies [[`d000bafbdeb0004d874acb2f2e6c6f8bc045d7f2`](https://github.com/livekit/agents-js/commit/d000bafbdeb0004d874acb2f2e6c6f8bc045d7f2)]:
  - @livekit/agents@1.0.9

## 1.0.8

### Patch Changes

- Updated dependencies [[`4627059d74346ac07282dcc8d02a68b1355b6741`](https://github.com/livekit/agents-js/commit/4627059d74346ac07282dcc8d02a68b1355b6741)]:
  - @livekit/agents@1.0.8

## 1.0.7

### Patch Changes

- Updated dependencies [[`b1c835817e0abec4cdc468cbd4e37fdd4635dde5`](https://github.com/livekit/agents-js/commit/b1c835817e0abec4cdc468cbd4e37fdd4635dde5), [`5f39a0c68d407fca2b9f46feb438dad47939d4fb`](https://github.com/livekit/agents-js/commit/5f39a0c68d407fca2b9f46feb438dad47939d4fb), [`e43a6a190b2e48ea0674c78e0ee7ed7cd9bdc5b9`](https://github.com/livekit/agents-js/commit/e43a6a190b2e48ea0674c78e0ee7ed7cd9bdc5b9), [`fd484279234edd83d7f1c0efb536f2a5a73c2846`](https://github.com/livekit/agents-js/commit/fd484279234edd83d7f1c0efb536f2a5a73c2846), [`435aade03993ad04db07d72114b8beaca1ffdc26`](https://github.com/livekit/agents-js/commit/435aade03993ad04db07d72114b8beaca1ffdc26), [`d162565191c7d42f087cecbd07ab92af6bbfaef8`](https://github.com/livekit/agents-js/commit/d162565191c7d42f087cecbd07ab92af6bbfaef8)]:
  - @livekit/agents@1.0.7

## 1.0.6

### Patch Changes

- Updated dependencies [[`9dd8641a13cc971866c4683a9122b426927af7c1`](https://github.com/livekit/agents-js/commit/9dd8641a13cc971866c4683a9122b426927af7c1)]:
  - @livekit/agents@1.0.6

## 1.0.5

### Patch Changes

- Updated dependencies [[`2b751812950e7d9075049ca643f63ebf153e48b2`](https://github.com/livekit/agents-js/commit/2b751812950e7d9075049ca643f63ebf153e48b2)]:
  - @livekit/agents@1.0.5

## 1.0.4

### Patch Changes

- Updated dependencies [[`3b49909cc0e4288d87bb344010837bec97bdde66`](https://github.com/livekit/agents-js/commit/3b49909cc0e4288d87bb344010837bec97bdde66), [`9006870c23136cfd6f173be3b689ab18b3295314`](https://github.com/livekit/agents-js/commit/9006870c23136cfd6f173be3b689ab18b3295314), [`2f0b4d8a482f36ad17195cbc62e1ed266efb96d3`](https://github.com/livekit/agents-js/commit/2f0b4d8a482f36ad17195cbc62e1ed266efb96d3)]:
  - @livekit/agents@1.0.4

## 1.0.3

### Patch Changes

- Updated dependencies [[`790e82f20e9b55c92c4b692018619d1d52cfbb6f`](https://github.com/livekit/agents-js/commit/790e82f20e9b55c92c4b692018619d1d52cfbb6f), [`d650e3058f446d8e883db20aaa5f85c4a99a7f04`](https://github.com/livekit/agents-js/commit/d650e3058f446d8e883db20aaa5f85c4a99a7f04)]:
  - @livekit/agents@1.0.3

## 1.0.2

### Patch Changes

- Updated dependencies [[`323a08c1dd8fb1fdc7aec11f7351d86bc6975815`](https://github.com/livekit/agents-js/commit/323a08c1dd8fb1fdc7aec11f7351d86bc6975815), [`52caa7bdc399524e5e44d1a9711c830e2061852f`](https://github.com/livekit/agents-js/commit/52caa7bdc399524e5e44d1a9711c830e2061852f), [`806d4bc8a5ee2c33ea4c71e46865fcf90b77d445`](https://github.com/livekit/agents-js/commit/806d4bc8a5ee2c33ea4c71e46865fcf90b77d445), [`45424482137a7cb60ab8ec79e40a83da4e0d8856`](https://github.com/livekit/agents-js/commit/45424482137a7cb60ab8ec79e40a83da4e0d8856), [`79089e4515a2082799335bbefb6897d201876986`](https://github.com/livekit/agents-js/commit/79089e4515a2082799335bbefb6897d201876986), [`b70c72bd2657556db8c1cb7518b3085401f04376`](https://github.com/livekit/agents-js/commit/b70c72bd2657556db8c1cb7518b3085401f04376)]:
  - @livekit/agents@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies [[`fa329b4d39e87cdb177017b86a5be5fee208c0e9`](https://github.com/livekit/agents-js/commit/fa329b4d39e87cdb177017b86a5be5fee208c0e9)]:
  - @livekit/agents@1.0.1

## 1.0.0

### Major Changes

- Release @livekit/agents and all plugins to version 1.0.0 - [#626](https://github.com/livekit/agents-js/pull/626) ([@toubatbrian](https://github.com/toubatbrian))

### Patch Changes

- Fix monorepo dependencies - [#634](https://github.com/livekit/agents-js/pull/634) ([@lukasIO](https://github.com/lukasIO))

- fix ctrl c logs - [#656](https://github.com/livekit/agents-js/pull/656) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- fix google LLM and gemini realtime - [#646](https://github.com/livekit/agents-js/pull/646) ([@toubatbrian](https://github.com/toubatbrian))

- pin onnxruntime to 1.21.1 - [#639](https://github.com/livekit/agents-js/pull/639) ([@toubatbrian](https://github.com/toubatbrian))

- update logs - [#643](https://github.com/livekit/agents-js/pull/643) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- Remove @jsr dependencies - [#630](https://github.com/livekit/agents-js/pull/630) ([@lukasIO](https://github.com/lukasIO))

- pin onnxruntime to be 1.21.0 aligned with deps in huggingface transformers.js - [#638](https://github.com/livekit/agents-js/pull/638) ([@toubatbrian](https://github.com/toubatbrian))

- fix nuphonic plugin - [#645](https://github.com/livekit/agents-js/pull/645) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- Updated dependencies [[`d2680831e197f9dd4a11e7b14fe98fc9aa1b549c`](https://github.com/livekit/agents-js/commit/d2680831e197f9dd4a11e7b14fe98fc9aa1b549c), [`1483b1cafa91300e3871a63cc01814ba9f462a85`](https://github.com/livekit/agents-js/commit/1483b1cafa91300e3871a63cc01814ba9f462a85), [`136b243b1bc6303509b8684352a04bf63a7ed598`](https://github.com/livekit/agents-js/commit/136b243b1bc6303509b8684352a04bf63a7ed598), [`20facf48a5c8d1bb5eb812bbb67b8840480158fc`](https://github.com/livekit/agents-js/commit/20facf48a5c8d1bb5eb812bbb67b8840480158fc), [`223a73c4dfea2275923024279729f3d13770d1d6`](https://github.com/livekit/agents-js/commit/223a73c4dfea2275923024279729f3d13770d1d6), [`9f481ac163445bcaf3609fdf9abc132af27f43e4`](https://github.com/livekit/agents-js/commit/9f481ac163445bcaf3609fdf9abc132af27f43e4), [`f7b2d32966129eaac266f180b860406c07118c8a`](https://github.com/livekit/agents-js/commit/f7b2d32966129eaac266f180b860406c07118c8a), [`57cf6eefb5fe6ff65c4af88a719282d60382e94a`](https://github.com/livekit/agents-js/commit/57cf6eefb5fe6ff65c4af88a719282d60382e94a), [`d67ef6daad137599c565cf1aa924954167d83ebf`](https://github.com/livekit/agents-js/commit/d67ef6daad137599c565cf1aa924954167d83ebf), [`f4afeb40bb005c103b3c33c6aa011cde2e29f729`](https://github.com/livekit/agents-js/commit/f4afeb40bb005c103b3c33c6aa011cde2e29f729), [`21e81a01e66c0f12d4ab6e1324c7be118ff013ae`](https://github.com/livekit/agents-js/commit/21e81a01e66c0f12d4ab6e1324c7be118ff013ae)]:
  - @livekit/agents@1.0.0

## 1.0.0-next.7

### Patch Changes

- fix ctrl c logs - [#656](https://github.com/livekit/agents-js/pull/656) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- Updated dependencies [[`136b243b1bc6303509b8684352a04bf63a7ed598`](https://github.com/livekit/agents-js/commit/136b243b1bc6303509b8684352a04bf63a7ed598)]:
  - @livekit/agents@1.0.0-next.7

## 1.0.0-next.6

### Patch Changes

- fix google LLM and gemini realtime - [#646](https://github.com/livekit/agents-js/pull/646) ([@toubatbrian](https://github.com/toubatbrian))

- Updated dependencies [[`20facf48a5c8d1bb5eb812bbb67b8840480158fc`](https://github.com/livekit/agents-js/commit/20facf48a5c8d1bb5eb812bbb67b8840480158fc)]:
  - @livekit/agents@1.0.0-next.6

## 1.0.0-next.5

### Patch Changes

- update logs - [#643](https://github.com/livekit/agents-js/pull/643) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- fix nuphonic plugin - [#645](https://github.com/livekit/agents-js/pull/645) ([@Shubhrakanti](https://github.com/Shubhrakanti))

- Updated dependencies [[`9f481ac163445bcaf3609fdf9abc132af27f43e4`](https://github.com/livekit/agents-js/commit/9f481ac163445bcaf3609fdf9abc132af27f43e4), [`21e81a01e66c0f12d4ab6e1324c7be118ff013ae`](https://github.com/livekit/agents-js/commit/21e81a01e66c0f12d4ab6e1324c7be118ff013ae)]:
  - @livekit/agents@1.0.0-next.5

## 1.0.0-next.4

### Patch Changes

- pin onnxruntime to 1.21.1 - [#639](https://github.com/livekit/agents-js/pull/639) ([@toubatbrian](https://github.com/toubatbrian))

- Updated dependencies [[`223a73c4dfea2275923024279729f3d13770d1d6`](https://github.com/livekit/agents-js/commit/223a73c4dfea2275923024279729f3d13770d1d6)]:
  - @livekit/agents@1.0.0-next.4

## 1.0.0-next.3

### Patch Changes

- pin onnxruntime to be 1.21.0 aligned with deps in huggingface transformers.js

- Updated dependencies []:
  - @livekit/agents@1.0.0-next.3

## 1.0.0-next.2

### Patch Changes

- Fix monorepo dependencies - [#634](https://github.com/livekit/agents-js/pull/634) ([@lukasIO](https://github.com/lukasIO))

- Updated dependencies [[`1483b1cafa91300e3871a63cc01814ba9f462a85`](https://github.com/livekit/agents-js/commit/1483b1cafa91300e3871a63cc01814ba9f462a85)]:
  - @livekit/agents@1.0.0-next.2

## 1.0.0-next.1

### Patch Changes

- Remove @jsr dependencies - [`9876876fa53c818fc3bef5e707baf5ff3c74262a`](https://github.com/livekit/agents-js/commit/9876876fa53c818fc3bef5e707baf5ff3c74262a) ([@lukasIO](https://github.com/lukasIO))

- Updated dependencies [[`9876876fa53c818fc3bef5e707baf5ff3c74262a`](https://github.com/livekit/agents-js/commit/9876876fa53c818fc3bef5e707baf5ff3c74262a)]:
  - @livekit/agents@1.0.0-next.1

## 1.0.0-next.0

### Major Changes

- Release @livekit/agents and all plugins to version 1.0.0 - [#626](https://github.com/livekit/agents-js/pull/626) ([@toubatbrian](https://github.com/toubatbrian))

### Patch Changes

- Updated dependencies [[`d2680831e197f9dd4a11e7b14fe98fc9aa1b549c`](https://github.com/livekit/agents-js/commit/d2680831e197f9dd4a11e7b14fe98fc9aa1b549c), [`57cf6eefb5fe6ff65c4af88a719282d60382e94a`](https://github.com/livekit/agents-js/commit/57cf6eefb5fe6ff65c4af88a719282d60382e94a), [`d67ef6daad137599c565cf1aa924954167d83ebf`](https://github.com/livekit/agents-js/commit/d67ef6daad137599c565cf1aa924954167d83ebf)]:
  - @livekit/agents@1.0.0-next.0

## 0.1.0

### Minor Changes

- initial version - Google Gemini LLM support using @google/genai SDK - [#593](https://github.com/livekit/agents-js/pull/593) ([@author](https://github.com/toubatbrian))

### Patch Changes

- Updated dependencies:
  - @livekit/agents@0.7.5
