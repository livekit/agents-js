# @livekit/agents-plugin-krisp

## 1.6.1

### Patch Changes

- Fix Krisp-processed audio being invisible to the rest of the pipeline - [#2130](https://github.com/livekit/agents-js/pull/2130) ([@toubatbrian](https://github.com/toubatbrian))

  The LiveKit Cloud backend is reached through `createRequire`, which resolves the internal
  package's `require` condition and so loads the CJS build of `@livekit/rtc-node` next to the
  ESM one the framework uses. Frames returned by that backend were instances of the CJS copy's
  `AudioFrame`, so every `instanceof AudioFrame` downstream failed. Adaptive interruption saw
  zero audio and classified every barge-in as a backchannel, making it impossible to interrupt
  an agent that had noise cancellation enabled. Frames are now adopted into the local binding
  before leaving the filter, sharing their samples rather than copying them.

- Set default noiseSuppressionLevel to 75 - [#2185](https://github.com/livekit/agents-js/pull/2185) ([@lukasIO](https://github.com/lukasIO))

- Updated dependencies [[`5010952`](https://github.com/livekit/agents-js/commit/5010952de1bae7b66c72981966f79f450dc8fc8c), [`db3263b`](https://github.com/livekit/agents-js/commit/db3263b47e940760570548c8cae76f83bb1b621e), [`37eda82`](https://github.com/livekit/agents-js/commit/37eda821631e44e182dbc4331df68715d471c3f0), [`6b6ba2b`](https://github.com/livekit/agents-js/commit/6b6ba2b8a11bf96ab48950edbb633127620f7f5a), [`67620fb`](https://github.com/livekit/agents-js/commit/67620fb963310fb26cef0f2d862023c705fd93f0), [`fd46904`](https://github.com/livekit/agents-js/commit/fd46904eeb91817dce99680876c50162573028cb), [`d4edb58`](https://github.com/livekit/agents-js/commit/d4edb58c1f7dc1636f516ef7d379da3a473d97b4), [`2446c9e`](https://github.com/livekit/agents-js/commit/2446c9e2a38f4595dfb3c474be36294bb09cd3db), [`262a602`](https://github.com/livekit/agents-js/commit/262a602e2452e946ad3c79212ac7412de5cdb704), [`d5d8d04`](https://github.com/livekit/agents-js/commit/d5d8d0487d2e99f49a1b56ab6b9e82b481491955), [`0daf8d6`](https://github.com/livekit/agents-js/commit/0daf8d61d92bfba5267d76a3871e7634a9111648), [`9d38c3e`](https://github.com/livekit/agents-js/commit/9d38c3ed8e6add6c8cfabb7c17a178e882db79b1), [`238a58c`](https://github.com/livekit/agents-js/commit/238a58c6bedbcea041676c2dfd6e72be1e3ac912), [`f7e9c0c`](https://github.com/livekit/agents-js/commit/f7e9c0c5295381051a7a50401383d975b3ce22b8), [`16c30ca`](https://github.com/livekit/agents-js/commit/16c30caec4a1d5b61ba8358fa69f81dea84915c1)]:
  - @livekit/agents@1.6.1

## 1.6.0

### Patch Changes

- Add krisp viva plugin - [#1904](https://github.com/livekit/agents-js/pull/1904) ([@lukasIO](https://github.com/lukasIO))

- Updated dependencies [[`83d75e3`](https://github.com/livekit/agents-js/commit/83d75e34d8837029afdbef12e0c4fda5b8b2c3a0), [`818db99`](https://github.com/livekit/agents-js/commit/818db99b394cecd50dc8cffd1dd25a899eff9eb9), [`c4705a7`](https://github.com/livekit/agents-js/commit/c4705a7579f40573a3460976616ba5b0a66e5108), [`54ee51c`](https://github.com/livekit/agents-js/commit/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f), [`1be8bef`](https://github.com/livekit/agents-js/commit/1be8bef5f01874d4f880ab01ee21a1171477bb5e), [`a30c5c3`](https://github.com/livekit/agents-js/commit/a30c5c3f421566f4a784696ac5c682c9521033c8), [`7d5a572`](https://github.com/livekit/agents-js/commit/7d5a572393623b9bfd9e472069c6d69fdbf6a017), [`6eca049`](https://github.com/livekit/agents-js/commit/6eca0499fe637ae33078508ad9f0c03bccf1cddb), [`7b6c9f7`](https://github.com/livekit/agents-js/commit/7b6c9f7172097adae850fd436980e5aa6e41ec70), [`03f381c`](https://github.com/livekit/agents-js/commit/03f381c6e4f408ebdb696de3622c88a90b9b56d6), [`78af6b6`](https://github.com/livekit/agents-js/commit/78af6b647e012aa895b2b85bbf50e1703dd50832), [`38490e5`](https://github.com/livekit/agents-js/commit/38490e587edbd92241c2000275f5a0b02fd8f600)]:
  - @livekit/agents@1.6.0
