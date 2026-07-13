# Krisp VIVA Plugin for LiveKit Agents

Real-time noise reduction for LiveKit voice agents using Krisp VIVA.

## Features

- `KrispVivaFilterFrameProcessor`: real-time noise reduction `FrameProcessor` for audio processing.

## Installation

```bash
npm install @livekit/agents-plugin-krisp
```

## Quick Start

By default, `KrispVivaFilterFrameProcessor` uses LiveKit Cloud authentication: the backend ships the noise-reduction model and authenticates against LiveKit Cloud using the room JWT the agent framework hands to the `FrameProcessor` automatically.

```typescript
import { AgentSession, inference } from '@livekit/agents';
import { KrispVivaFilterFrameProcessor } from '@livekit/agents-plugin-krisp';

const processor = new KrispVivaFilterFrameProcessor({
  noiseSuppressionLevel: 100,
});

const session = new AgentSession({
  stt: new inference.STT({ model: 'deepgram/nova-3' }),
  llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
  tts: new inference.TTS({ model: 'cartesia/sonic-3' }),
});

await session.start({
  agent: myAgent,
  room: ctx.room,
  inputOptions: {
    noiseCancellation: processor,
  },
});
```

Audio pipeline: `Room -> RoomIO (with KrispVivaFilterFrameProcessor) -> VAD -> STT -> LLM`.

## Configuration

| Parameter               | Type                                                   | Default                    | Description                                                                                          |
| ----------------------- | ------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `authProvider`          | `LiveKitCloudAuthProvider \| KrispLicenseAuthProvider` | `LiveKitCloudAuthProvider` | Authentication backend. Defaults to LiveKit Cloud. See the alternative below.                        |
| `noiseSuppressionLevel` | `number`                                               | `100`                      | Noise reduction intensity (0-100).                                                                   |
| `frameDurationMs`       | `number`                                               | `undefined`                | Deprecated. Input frames of any size are buffered automatically.                                     |
| `sampleRate`            | `number`                                               | `undefined`                | Deprecated. The processor adapts to the input sample rate automatically.                             |
| `modelPath`             | `string`                                               | `undefined`                | Deprecated. Use `authProvider: new auth.KrispLicenseAuthProvider({ modelPath })`. License-mode only. |

## Alternative: Krisp License Auth

Most users should use the default LiveKit Cloud path above. This alternative is for running a Krisp SDK directly with your own Krisp license, for example when using a LiveKit OSS server.

```typescript
import { KrispVivaFilterFrameProcessor, auth } from '@livekit/agents-plugin-krisp';

const processor = new KrispVivaFilterFrameProcessor({
  authProvider: new auth.KrispLicenseAuthProvider({
    licenseKey: '...',
    modelPath: '/path/to/noise_model.kef',
  }),
  noiseSuppressionLevel: 100,
});
```

`licenseKey` and `modelPath` fall back to `KRISP_VIVA_SDK_LICENSE_KEY` and `KRISP_VIVA_FILTER_MODEL_PATH` when omitted.

## Troubleshooting

### Bundled backend missing

The JavaScript port exposes the same LiveKit Cloud auth facade and `FrameProcessor` lifecycle hooks as Python. Runtime cloud processing requires a Node backend package that exports `KrispVivaFilterFrameProcessor` from `@livekit/agents-plugin-krisp-internal`.

### Krisp SDK initialization failed or licensing errors

Make sure the license key is set:

```bash
export KRISP_VIVA_SDK_LICENSE_KEY=your-license-key-here
```

### Model path must be provided

```bash
export KRISP_VIVA_FILTER_MODEL_PATH=/path/to/model.kef
```

### Unsupported sample rate

Supported: 8000, 16000, 24000, 32000, 44100, 48000 Hz.

## License

The source code in this package is licensed under Apache-2.0.

The default backend is a separate, closed-source package that is proprietary and distributed under the LiveKit Terms of Service. That backend bundles the Krisp VIVA SDK along with its third-party open-source components, whose attribution notices are shipped inside the package.

The Krisp license alternative (`KrispLicenseAuthProvider`) needs a proprietary Krisp Audio SDK together with your own Krisp license key and model file, governed by your agreement with Krisp.
