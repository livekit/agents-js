# @livekit/agents-plugin-did

## 1.4.10

### Patch Changes

- Updated dependencies [[`fafdeb68c59404adc3dfabaece10ea155a5b30c4`](https://github.com/livekit/agents-js/commit/fafdeb68c59404adc3dfabaece10ea155a5b30c4), [`7309e113bd98ba620e84cc216d12395e32662186`](https://github.com/livekit/agents-js/commit/7309e113bd98ba620e84cc216d12395e32662186), [`ad8e138fabad04b7b26069a5ae6d50ce56008037`](https://github.com/livekit/agents-js/commit/ad8e138fabad04b7b26069a5ae6d50ce56008037), [`ad8e138fabad04b7b26069a5ae6d50ce56008037`](https://github.com/livekit/agents-js/commit/ad8e138fabad04b7b26069a5ae6d50ce56008037), [`ad8e138fabad04b7b26069a5ae6d50ce56008037`](https://github.com/livekit/agents-js/commit/ad8e138fabad04b7b26069a5ae6d50ce56008037), [`ad8e138fabad04b7b26069a5ae6d50ce56008037`](https://github.com/livekit/agents-js/commit/ad8e138fabad04b7b26069a5ae6d50ce56008037), [`ad8e138fabad04b7b26069a5ae6d50ce56008037`](https://github.com/livekit/agents-js/commit/ad8e138fabad04b7b26069a5ae6d50ce56008037), [`06f29bf78f094e02d3ec8a8a6bb5d793c82d2a1f`](https://github.com/livekit/agents-js/commit/06f29bf78f094e02d3ec8a8a6bb5d793c82d2a1f)]:
  - @livekit/agents@1.4.10

## 1.4.9

### Patch Changes

- Updated dependencies [[`3c45ddaa6d7d6f3dbd52a4ed19462b59dced66a3`](https://github.com/livekit/agents-js/commit/3c45ddaa6d7d6f3dbd52a4ed19462b59dced66a3), [`bad0a7ffdade30a5c379d045201433e2afb32c8c`](https://github.com/livekit/agents-js/commit/bad0a7ffdade30a5c379d045201433e2afb32c8c), [`294782fbe47d185ac8adc1f58031a39084891a98`](https://github.com/livekit/agents-js/commit/294782fbe47d185ac8adc1f58031a39084891a98)]:
  - @livekit/agents@1.4.9

## 1.4.8

### Patch Changes

- Updated dependencies [[`d662ec6b2ff047a60e4f9215c99794748497b675`](https://github.com/livekit/agents-js/commit/d662ec6b2ff047a60e4f9215c99794748497b675)]:
  - @livekit/agents@1.4.8

## 1.4.7

### Patch Changes

- Updated dependencies [[`27a6e829350c13fcdca533d68f864bebda70de89`](https://github.com/livekit/agents-js/commit/27a6e829350c13fcdca533d68f864bebda70de89), [`9cc7215bc08c34f24b5d9f7f8fbe754d7e67c267`](https://github.com/livekit/agents-js/commit/9cc7215bc08c34f24b5d9f7f8fbe754d7e67c267), [`ed2364ad105d7fde9baccc463a7bdbffa6a1699c`](https://github.com/livekit/agents-js/commit/ed2364ad105d7fde9baccc463a7bdbffa6a1699c), [`ed2364ad105d7fde9baccc463a7bdbffa6a1699c`](https://github.com/livekit/agents-js/commit/ed2364ad105d7fde9baccc463a7bdbffa6a1699c), [`27a6e829350c13fcdca533d68f864bebda70de89`](https://github.com/livekit/agents-js/commit/27a6e829350c13fcdca533d68f864bebda70de89), [`e64698c2e67048ff577d5024488929193d0b60e4`](https://github.com/livekit/agents-js/commit/e64698c2e67048ff577d5024488929193d0b60e4), [`ec4a2a48d7ba1f6c20a86303b264188fa47fae0d`](https://github.com/livekit/agents-js/commit/ec4a2a48d7ba1f6c20a86303b264188fa47fae0d), [`e1acca813568869fd345b5eee16be211e8595d9b`](https://github.com/livekit/agents-js/commit/e1acca813568869fd345b5eee16be211e8595d9b), [`bb8e6251354062714e39ae5a44244e1ef65b385b`](https://github.com/livekit/agents-js/commit/bb8e6251354062714e39ae5a44244e1ef65b385b), [`ed2364ad105d7fde9baccc463a7bdbffa6a1699c`](https://github.com/livekit/agents-js/commit/ed2364ad105d7fde9baccc463a7bdbffa6a1699c)]:
  - @livekit/agents@1.4.7

## 1.4.6

### Patch Changes

- feat(d-id): add D-ID avatar plugin - [#1670](https://github.com/livekit/agents-js/pull/1670) ([@osimhi213](https://github.com/osimhi213))

  Dispatches a D-ID v4 (expressive) avatar worker into a LiveKit room via `POST /v2/agents/{agent_id}/sessions/join` and routes the agent's audio to it through `voice.DataStreamAudioOutput`. Audio sample rate is configurable (16k / 24k / 48k, default 24k) via `AudioConfig`. See `examples/src/did_avatar.ts` for usage.

- Updated dependencies [[`2eeccad1136111152a461765a71271c03c339a3b`](https://github.com/livekit/agents-js/commit/2eeccad1136111152a461765a71271c03c339a3b), [`27de4099f0bd66aa02a5aa040f00767b855742e2`](https://github.com/livekit/agents-js/commit/27de4099f0bd66aa02a5aa040f00767b855742e2), [`84cec47eb2af21bfead10878b866e1b564226ac1`](https://github.com/livekit/agents-js/commit/84cec47eb2af21bfead10878b866e1b564226ac1), [`1a3ef4c9332f435f88fc716c791d6263164ecb2e`](https://github.com/livekit/agents-js/commit/1a3ef4c9332f435f88fc716c791d6263164ecb2e), [`ef27e91427a06d336e6343bdec55966b45ec5b69`](https://github.com/livekit/agents-js/commit/ef27e91427a06d336e6343bdec55966b45ec5b69), [`5267ce6a582191a607bd76f3db90123586636713`](https://github.com/livekit/agents-js/commit/5267ce6a582191a607bd76f3db90123586636713), [`b942b0d02ea44a86b887bcae36a5b4b0d417312d`](https://github.com/livekit/agents-js/commit/b942b0d02ea44a86b887bcae36a5b4b0d417312d), [`596285f50e7537b5faf3739765b6b7df827b0823`](https://github.com/livekit/agents-js/commit/596285f50e7537b5faf3739765b6b7df827b0823), [`1d27d25a5c26a178929c520f1cc58861239469ad`](https://github.com/livekit/agents-js/commit/1d27d25a5c26a178929c520f1cc58861239469ad), [`36b4f7538b6cfa85e28834b17600d18f851a76cc`](https://github.com/livekit/agents-js/commit/36b4f7538b6cfa85e28834b17600d18f851a76cc), [`3f3969223569e63eb98d57abfcb2b0d6345f9981`](https://github.com/livekit/agents-js/commit/3f3969223569e63eb98d57abfcb2b0d6345f9981), [`5154150131b0c62290b0ad84170927417b558765`](https://github.com/livekit/agents-js/commit/5154150131b0c62290b0ad84170927417b558765), [`7ed8af73c1a893d051f533642235107f52183efc`](https://github.com/livekit/agents-js/commit/7ed8af73c1a893d051f533642235107f52183efc), [`b55a41181bd377f90cd48388dacf653f2eb1a15f`](https://github.com/livekit/agents-js/commit/b55a41181bd377f90cd48388dacf653f2eb1a15f), [`ac49bfe7639a7772bf128e337d0dd2e371eb66d5`](https://github.com/livekit/agents-js/commit/ac49bfe7639a7772bf128e337d0dd2e371eb66d5), [`97e17e3c69834cef22c74bc3cc13c5a38b9115a8`](https://github.com/livekit/agents-js/commit/97e17e3c69834cef22c74bc3cc13c5a38b9115a8), [`c220cfd5a32a2eb5c0e9c0e896ea3510580a08ff`](https://github.com/livekit/agents-js/commit/c220cfd5a32a2eb5c0e9c0e896ea3510580a08ff), [`7d3b9b531c08286d4389bea9e231824bd6110f1b`](https://github.com/livekit/agents-js/commit/7d3b9b531c08286d4389bea9e231824bd6110f1b)]:
  - @livekit/agents@1.4.6
