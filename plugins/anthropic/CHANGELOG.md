# @livekit/agents-plugin-anthropic

## 1.6.2

### Patch Changes

- Prewarm LLM provider connections before the first inference request. - [#2106](https://github.com/livekit/agents-js/pull/2106) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Disable Anthropic SDK retries by default so the framework owns retry behavior. - [#2198](https://github.com/livekit/agents-js/pull/2198) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

  The Anthropic SDK client created by the plugin is now constructed with `maxRetries: 0`, so the vendor SDK no longer retries requests on its own. Retries are owned entirely by the framework's `connOptions`, which avoids compounding vendor retries with framework retries. Pass `maxRetries` to `LLM` to restore vendor-side retries, or inject your own `client` — an injected client's retry policy is left untouched.

- Updated dependencies [[`8159eb0`](https://github.com/livekit/agents-js/commit/8159eb0bf95f7abf392aaf4ba0ee202e212f341b), [`762d856`](https://github.com/livekit/agents-js/commit/762d856480ed8cc26b98c80f97c4f1f5f95b825f), [`5700974`](https://github.com/livekit/agents-js/commit/5700974609de1bfabe2481e8462590e25fc92cf5), [`20e4fb9`](https://github.com/livekit/agents-js/commit/20e4fb9ef5710b34a24bb3fa505334d753d82a5a), [`569ba7d`](https://github.com/livekit/agents-js/commit/569ba7d9767ba0bf8a1bbdc851243fd7ef0ec633), [`8260fa1`](https://github.com/livekit/agents-js/commit/8260fa1ee4ea1ec3b111e87475aa89f49ec4dadf), [`ab0875a`](https://github.com/livekit/agents-js/commit/ab0875a82261d851384c236f6f22ecf62c30ac03), [`d96cd05`](https://github.com/livekit/agents-js/commit/d96cd050c1603bdf43816ec368e6f8d384cccc03)]:
  - @livekit/agents@1.6.2

## 1.6.1

### Patch Changes

- Updated dependencies [[`5010952`](https://github.com/livekit/agents-js/commit/5010952de1bae7b66c72981966f79f450dc8fc8c), [`db3263b`](https://github.com/livekit/agents-js/commit/db3263b47e940760570548c8cae76f83bb1b621e), [`37eda82`](https://github.com/livekit/agents-js/commit/37eda821631e44e182dbc4331df68715d471c3f0), [`6b6ba2b`](https://github.com/livekit/agents-js/commit/6b6ba2b8a11bf96ab48950edbb633127620f7f5a), [`67620fb`](https://github.com/livekit/agents-js/commit/67620fb963310fb26cef0f2d862023c705fd93f0), [`fd46904`](https://github.com/livekit/agents-js/commit/fd46904eeb91817dce99680876c50162573028cb), [`d4edb58`](https://github.com/livekit/agents-js/commit/d4edb58c1f7dc1636f516ef7d379da3a473d97b4), [`2446c9e`](https://github.com/livekit/agents-js/commit/2446c9e2a38f4595dfb3c474be36294bb09cd3db), [`262a602`](https://github.com/livekit/agents-js/commit/262a602e2452e946ad3c79212ac7412de5cdb704), [`d5d8d04`](https://github.com/livekit/agents-js/commit/d5d8d0487d2e99f49a1b56ab6b9e82b481491955), [`0daf8d6`](https://github.com/livekit/agents-js/commit/0daf8d61d92bfba5267d76a3871e7634a9111648), [`9d38c3e`](https://github.com/livekit/agents-js/commit/9d38c3ed8e6add6c8cfabb7c17a178e882db79b1), [`238a58c`](https://github.com/livekit/agents-js/commit/238a58c6bedbcea041676c2dfd6e72be1e3ac912), [`f7e9c0c`](https://github.com/livekit/agents-js/commit/f7e9c0c5295381051a7a50401383d975b3ce22b8), [`16c30ca`](https://github.com/livekit/agents-js/commit/16c30caec4a1d5b61ba8358fa69f81dea84915c1)]:
  - @livekit/agents@1.6.1

## 1.6.0

### Patch Changes

- Updated dependencies [[`83d75e3`](https://github.com/livekit/agents-js/commit/83d75e34d8837029afdbef12e0c4fda5b8b2c3a0), [`818db99`](https://github.com/livekit/agents-js/commit/818db99b394cecd50dc8cffd1dd25a899eff9eb9), [`c4705a7`](https://github.com/livekit/agents-js/commit/c4705a7579f40573a3460976616ba5b0a66e5108), [`54ee51c`](https://github.com/livekit/agents-js/commit/54ee51c99ba5d2c4a9ad9d6389fe34de2c47d92f), [`1be8bef`](https://github.com/livekit/agents-js/commit/1be8bef5f01874d4f880ab01ee21a1171477bb5e), [`a30c5c3`](https://github.com/livekit/agents-js/commit/a30c5c3f421566f4a784696ac5c682c9521033c8), [`7d5a572`](https://github.com/livekit/agents-js/commit/7d5a572393623b9bfd9e472069c6d69fdbf6a017), [`6eca049`](https://github.com/livekit/agents-js/commit/6eca0499fe637ae33078508ad9f0c03bccf1cddb), [`7b6c9f7`](https://github.com/livekit/agents-js/commit/7b6c9f7172097adae850fd436980e5aa6e41ec70), [`03f381c`](https://github.com/livekit/agents-js/commit/03f381c6e4f408ebdb696de3622c88a90b9b56d6), [`78af6b6`](https://github.com/livekit/agents-js/commit/78af6b647e012aa895b2b85bbf50e1703dd50832), [`38490e5`](https://github.com/livekit/agents-js/commit/38490e587edbd92241c2000275f5a0b02fd8f600)]:
  - @livekit/agents@1.6.0

## 1.5.5

### Patch Changes

- Add raw chat message text access and strip LiveKit expression markup from assistant text content. - [#2087](https://github.com/livekit/agents-js/pull/2087) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Updated dependencies [[`8d0f5ae`](https://github.com/livekit/agents-js/commit/8d0f5ae72ff15ab245e77ec466f2fe746dd2d151), [`82d93d0`](https://github.com/livekit/agents-js/commit/82d93d02914a81f216e22c10eb9a28e79885416a), [`4c718be`](https://github.com/livekit/agents-js/commit/4c718be49cf5b83f3c0e55ce8ef654bf5eb047d1), [`687ddf7`](https://github.com/livekit/agents-js/commit/687ddf7703401ab59d99c008bafb6c529dfcf6f6), [`3346ff1`](https://github.com/livekit/agents-js/commit/3346ff16e2a09b223286794a5e0d1e1b2b6d8758), [`71a19e0`](https://github.com/livekit/agents-js/commit/71a19e0a7bfb6035d4ab9f797cfc5fe69fda1ab2), [`f4190ec`](https://github.com/livekit/agents-js/commit/f4190ec583e224e0942e2a594b6a332846f84ac7)]:
  - @livekit/agents@1.5.5

## 1.5.4

### Patch Changes

- Updated dependencies [[`41411c8`](https://github.com/livekit/agents-js/commit/41411c8d61712297b5b89320f93782dda0d3274b), [`3750be5`](https://github.com/livekit/agents-js/commit/3750be58e037c8a209e80ee86b467f8ee1237c2f), [`0f1e7ca`](https://github.com/livekit/agents-js/commit/0f1e7ca9dccf7028c9c5441fe2f7294c22375c25), [`f7eaf9c`](https://github.com/livekit/agents-js/commit/f7eaf9c46344e8dc6cbf459bb5757ec860d5f087), [`1e111d7`](https://github.com/livekit/agents-js/commit/1e111d73800482bab71c4509a56e2e24e8fe2271), [`5724826`](https://github.com/livekit/agents-js/commit/5724826141fc8e69cb66afc65121183c41c5623a), [`65aa60f`](https://github.com/livekit/agents-js/commit/65aa60fadc9676af9585ab2df427ba19690c89d1), [`d34130f`](https://github.com/livekit/agents-js/commit/d34130ff3f5c70bd30165dd93dc245693e918184)]:
  - @livekit/agents@1.5.4

## 1.5.3

### Patch Changes

- Updated dependencies [[`3c19945`](https://github.com/livekit/agents-js/commit/3c1994531efc43975fec30d29289b06abdd6b14f), [`7db92dd`](https://github.com/livekit/agents-js/commit/7db92dd9808c7df5aeb7d06286496a31f49674ba), [`b9d8e95`](https://github.com/livekit/agents-js/commit/b9d8e95b3dbe62cf21e66e345495acb6d8dd768b), [`bad25fd`](https://github.com/livekit/agents-js/commit/bad25fd1dba0e6676fc1153a443dc6acde82626d), [`206e884`](https://github.com/livekit/agents-js/commit/206e884914f8beb658235351bf1c6a20b98d3ac6), [`16ac15e`](https://github.com/livekit/agents-js/commit/16ac15ecbeebe0e3d9e21edf4a29bdb90c969b33), [`6300c1c`](https://github.com/livekit/agents-js/commit/6300c1c9242690589866c6767238aa0c31f3ad30), [`dfd6654`](https://github.com/livekit/agents-js/commit/dfd66540e1e7eb00f8c0b0bfc830e9eeaf0f33ed), [`97c5aa2`](https://github.com/livekit/agents-js/commit/97c5aa23a73eb48e128300f8f58d3c9a79db4be1), [`13a191c`](https://github.com/livekit/agents-js/commit/13a191c71088bdd9d4db112f9b57976c1530753f), [`508236a`](https://github.com/livekit/agents-js/commit/508236a77d5b3dd97b93c3b47030f5852dcdd5fe), [`2312eed`](https://github.com/livekit/agents-js/commit/2312eedf02dceaed0ef8554f545c2a5acd720121)]:
  - @livekit/agents@1.5.3

## 1.5.2

### Patch Changes

- Updated dependencies []:
  - @livekit/agents@1.5.2

## 1.5.1

### Patch Changes

- fix(anthropic): add non-whitespace trailing dummy - [#1588](https://github.com/livekit/agents-js/pull/1588) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- added anthropic plugin - [#1588](https://github.com/livekit/agents-js/pull/1588) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Updated dependencies [[`5e8431a`](https://github.com/livekit/agents-js/commit/5e8431a7044d764bfcb575905068a7e13d39b5cf), [`8ded843`](https://github.com/livekit/agents-js/commit/8ded84301a2eb9de306b3a0aab2548726a488c17), [`213b284`](https://github.com/livekit/agents-js/commit/213b2840bb7b71146801258a8537f3ba28f633ff), [`c20907c`](https://github.com/livekit/agents-js/commit/c20907c048dfc07746b78a1d1d98fdc751c4a814), [`a0144bb`](https://github.com/livekit/agents-js/commit/a0144bb862f16f0c468ae529698bd8ac98adb00f), [`a0144bb`](https://github.com/livekit/agents-js/commit/a0144bb862f16f0c468ae529698bd8ac98adb00f), [`36e6460`](https://github.com/livekit/agents-js/commit/36e64603f62e41106b7712ce3c5a373bb516ffcd), [`92d7244`](https://github.com/livekit/agents-js/commit/92d7244b4fa1282b649f222c2459c6cfdf059067), [`9738429`](https://github.com/livekit/agents-js/commit/973842982c4377958dad3e462ae05683181dcdb4), [`1f881c2`](https://github.com/livekit/agents-js/commit/1f881c2b485b0dc0fcb20b835a470c7b243a4899), [`a0144bb`](https://github.com/livekit/agents-js/commit/a0144bb862f16f0c468ae529698bd8ac98adb00f), [`6dbf08f`](https://github.com/livekit/agents-js/commit/6dbf08fdb780ee2b841b117ba96103732fa4814f), [`7a5da25`](https://github.com/livekit/agents-js/commit/7a5da253691d00c1699cf39abe5a61aea22b8331), [`42a5355`](https://github.com/livekit/agents-js/commit/42a5355be4a53bdc4c9e251cef09fbb9002f1655)]:
  - @livekit/agents@1.5.1
