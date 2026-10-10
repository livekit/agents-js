---
'@livekit/agents': minor
---

Port the Python `AudioEmitter` and streaming audio decoder to the core framework.

`tts.AudioEmitter` turns raw provider bytes into correctly-framed `SynthesizedAudio` packets:
it decodes non-PCM formats, chunks audio progressively (20ms ramping to the target frame size,
so the first audio reaches the pipeline sooner), tracks segments and their durations, marks the
last frame of each segment `final`, and auto-flushes its buffered tail when a provider generates
slower than realtime. Plugins get one from `createAudioEmitter()` inside `run()`.

`codecs.AudioStreamDecoder` decodes container and compressed audio (`audio/mpeg`, `audio/wav`,
`audio/ogg`, `audio/webm`, …) to raw PCM through the bundled ffmpeg binary, so TTS plugins are no
longer limited to providers that can return raw PCM.

`AudioByteStream` gains a `progressive` mode, `resetProgressive()`, `clear()` and
`bufferedDuration`. Its `flush()` now emits the buffered complete samples and retains a trailing
partial sample for the next write, instead of dropping the entire buffer — previously a chunk
that ended mid-sample discarded every byte held at that moment.

No plugins are migrated yet; the existing queue-based contract is unchanged.
