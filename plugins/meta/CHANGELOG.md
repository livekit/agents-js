# @livekit/agents-plugin-meta

## 1.9.1

### Patch Changes

- Stop the STT send loops from retaining every audio frame for the life of a stream, and from stealing the next attempt's first frame. `inference.STT` and the Cartesia, Deepgram and Meta STTs raced each read against one long-lived abort promise; every race appended a reaction to that never-settling promise, and each reaction kept the settled read and its `AudioFrame` alive (nodejs/node#17469) — about 8 MB per minute per stream under continuous speech, until the job hit its memory limit. Reads now go through the input queue's cancellable `next({ signal })`, so a torn-down sender's read is cancelled instead of left parked in the queue, and any remaining race goes through `waitUntilAborted`, which installs and removes its own abort listener per call. `Queue.get` and `AsyncIterableQueue.next` now honour an already-aborted signal even when items are buffered, so a cancelled reader never takes a frame the replacement reader needs. - [#2544](https://github.com/livekit/agents-js/pull/2544) ([@praveen4star](https://github.com/praveen4star))

- Updated dependencies [[`3b086bc`](https://github.com/livekit/agents-js/commit/3b086bc19a403cd1d622f8e458c744ad69fb48a5), [`72898e1`](https://github.com/livekit/agents-js/commit/72898e1e583874860b5a1d8d241195ecf8d99d54), [`f6ea8df`](https://github.com/livekit/agents-js/commit/f6ea8df234c9f4a992e67908f3f100c956a9acc0), [`7e23bc5`](https://github.com/livekit/agents-js/commit/7e23bc56364cdd411163e31fc0b74bafc75851c3), [`3a8b621`](https://github.com/livekit/agents-js/commit/3a8b6210cb0175c79d410afae5fe0bba0c19c08d), [`c9e1f26`](https://github.com/livekit/agents-js/commit/c9e1f26172681190257e8e01b86c7fe90e4e15dd), [`f6f9e7a`](https://github.com/livekit/agents-js/commit/f6f9e7ad1614d22c21b935ee4101a727eea1b145), [`d3a0abe`](https://github.com/livekit/agents-js/commit/d3a0abead85e7d9db79c355b345c515eb6aa42fe), [`21aa476`](https://github.com/livekit/agents-js/commit/21aa4763f2b89506fb1e56f6879b23e41a5bcfa6), [`38f65f8`](https://github.com/livekit/agents-js/commit/38f65f8a4c790f0bc4b62b1aba407cf1f95a2360), [`646f0bc`](https://github.com/livekit/agents-js/commit/646f0bc70f4a55d9b282dde8b25ebfb5be818fb7), [`1244049`](https://github.com/livekit/agents-js/commit/1244049976d3caea04debef32ad72e4785f20d99), [`1244049`](https://github.com/livekit/agents-js/commit/1244049976d3caea04debef32ad72e4785f20d99), [`1fc4290`](https://github.com/livekit/agents-js/commit/1fc429084d063d7b7fd4f61eec0df3378b066777), [`5287be1`](https://github.com/livekit/agents-js/commit/5287be114b12fb16f0a3eb6ccca4173e6e3eb219), [`d650cc0`](https://github.com/livekit/agents-js/commit/d650cc025c6322e0bc822a9ab6cace9d1fa29648), [`f089dc5`](https://github.com/livekit/agents-js/commit/f089dc52967ccab3f70db449dddc52af664dea61), [`40bf9b1`](https://github.com/livekit/agents-js/commit/40bf9b13f3b71fe50076f53609aa63af449737b4), [`1244049`](https://github.com/livekit/agents-js/commit/1244049976d3caea04debef32ad72e4785f20d99), [`b7ad990`](https://github.com/livekit/agents-js/commit/b7ad990c5faa424b31697bd2e868232f81f2bdf5), [`7ab8bd8`](https://github.com/livekit/agents-js/commit/7ab8bd801bc78d3c88c8b50904f1d90e81d976b8), [`b7ad990`](https://github.com/livekit/agents-js/commit/b7ad990c5faa424b31697bd2e868232f81f2bdf5), [`546dc33`](https://github.com/livekit/agents-js/commit/546dc3330d2543a61f3291b60e72e881d4b1e4b4), [`5481379`](https://github.com/livekit/agents-js/commit/5481379b435119aba4ae00779ce6f3c2e2e39977)]:
  - @livekit/agents@1.9.1

## 1.9.0

### Patch Changes

- Updated dependencies [[`d074b68`](https://github.com/livekit/agents-js/commit/d074b68b0fcb0f96768b425f27167a3c6ea2e5cd), [`3b068a5`](https://github.com/livekit/agents-js/commit/3b068a5679eae29ed114dfc7caa114dd9145accc), [`78dde70`](https://github.com/livekit/agents-js/commit/78dde705069bf38a3e9abcc6561c7163911b0ae7), [`931a217`](https://github.com/livekit/agents-js/commit/931a217014cd9425130d6580cc4cec2c44de96dc), [`c82fd8c`](https://github.com/livekit/agents-js/commit/c82fd8ca4046d3d03d235007953c17c19d9d766a)]:
  - @livekit/agents@1.9.0

## 1.8.1

### Patch Changes

- Add streaming speech recognition for Meta Muse Voice Transcribe. - [#2455](https://github.com/livekit/agents-js/pull/2455) ([@rosetta-livekit-bot](https://github.com/apps/rosetta-livekit-bot))

- Updated dependencies [[`d92443a`](https://github.com/livekit/agents-js/commit/d92443a80be4db735e72d845129d4f99c7186374), [`679d044`](https://github.com/livekit/agents-js/commit/679d044a80c6e916f203f392098eaeb0549bb95d), [`b11b7b4`](https://github.com/livekit/agents-js/commit/b11b7b4d0d734082b3d2d21a447b0b093b4482fc), [`63d46a0`](https://github.com/livekit/agents-js/commit/63d46a03f1958cc9bec647a71b95517202ae2447), [`42ec937`](https://github.com/livekit/agents-js/commit/42ec937ca1882f1e826e8532dbb33e7623bfa9df), [`1f9f63a`](https://github.com/livekit/agents-js/commit/1f9f63ab737d59d31e5adb353bf56d835a102298), [`6b44bca`](https://github.com/livekit/agents-js/commit/6b44bcac254dcebb826d8cbeade4aae64d041b5f), [`2b93dbe`](https://github.com/livekit/agents-js/commit/2b93dbe8a4653f9bde0a2cf046a3c4ba64da39db), [`ced62f2`](https://github.com/livekit/agents-js/commit/ced62f2c7ad94dd87fb00b5752415c3cf95b2d2c), [`8ef21bf`](https://github.com/livekit/agents-js/commit/8ef21bf1e40a362b6d30b817e20500125859e23b), [`c69a50a`](https://github.com/livekit/agents-js/commit/c69a50a3542f99e4b7a62a36a70bf9eacd7b4b73), [`01094a6`](https://github.com/livekit/agents-js/commit/01094a691117a6d3d18954697bd52607211fcf5a), [`b4cadac`](https://github.com/livekit/agents-js/commit/b4cadacc6aa577a1aa0b017f8831e9ff0e2cb863)]:
  - @livekit/agents@1.8.1

## 1.8.0

Initial release.
