<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Krisp VIVA plugin for LiveKit Agents

Real-time noise reduction for LiveKit voice agents using [Krisp's VIVA SDK](https://krisp.ai), exposed as a LiveKit `FrameProcessor`.

See [https://docs.livekit.io/agents/integrations/](https://docs.livekit.io/agents/integrations/) for more information.

## Installation

```bash
pnpm add @livekit/agents-plugin-krisp
```

The default backend is bundled with the plugin and authenticates through LiveKit Cloud using the room's credentials — no separate SDK download, license key, or model file is required.

> Using your own [Krisp license](#alternative-krisp-license-auth) instead? That path has additional prerequisites — see below.

## Quick start

`krisp.vivaFilter()` resolves its backend from the environment: if both `KRISP_VIVA_SDK_LICENSE_KEY` and `KRISP_VIVA_FILTER_MODEL_PATH` are set, it uses the [Krisp license path](#alternative-krisp-license-auth) (you are responsible for installing `krisp-audio-node-sdk`); otherwise it uses **LiveKit Cloud** authentication — the bundled backend ships the voice isolation model and authenticates against LiveKit Cloud using the room JWT the agent framework hands to the `FrameProcessor` automatically. Pass `authProvider` to pin a backend explicitly.

Pass the processor as `noiseCancellation` in the session's input options:

```ts
import { type JobContext, voice } from '@livekit/agents';
import * as krisp from '@livekit/agents-plugin-krisp';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';

export default async function entry(ctx: JobContext) {
  // Default: LiveKit Cloud auth + bundled model. No keys or model files.
  const noiseCancellation = krisp.vivaFilter({
    noiseSuppressionLevel: 100, // 0-100
  });

  const session = new voice.AgentSession({
    vad: await silero.VAD.load(),
    stt: new openai.STT(),
    llm: new openai.LLM({ model: 'gpt-4o-mini' }),
    tts: new openai.TTS(),
  });

  await session.start({
    agent: new voice.Agent({ instructions: 'You are a helpful assistant.' }),
    room: ctx.room,
    inputOptions: {
      // Pass the FrameProcessor directly.
      noiseCancellation,
    },
  });
}
```

**Audio pipeline:** `Room → RoomIO (with vivaFilter) → VAD → STT → LLM`

## Configuration

### `KrispVivaFilterOptions`

| Option                  | Type           | Default                    | Description                                                                                                |
| ----------------------- | -------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `authProvider`          | `AuthProvider` | `LiveKitCloudAuthProvider` | Authentication backend. Defaults to LiveKit Cloud. See [the alternative](#alternative-krisp-license-auth). |
| `noiseSuppressionLevel` | `number`       | `100`                      | Noise reduction intensity (0-100).                                                                         |

Input frames of any size and sample rate are buffered and adapted automatically.

### Runtime control

```ts
noiseCancellation.setEnabled(false); // pass audio through unmodified
noiseCancellation.setNoiseSuppressionLevel(50); // adjust 0-100 on the fly
noiseCancellation.close(); // free resources when done
```

## Alternative: Krisp license auth

> **Most users should use the default LiveKit Cloud path above.** This alternative is for running the public Krisp SDK directly with your own Krisp license — for example, when using the LiveKit OSS server.

This path uses the public `krisp-audio-node-sdk` together with a Krisp license key and a `.kef` model file that you obtain from Krisp.

### Prerequisites

1. **Krisp Node SDK** — proprietary, not bundled with this plugin. Obtain and install it separately from [Krisp](https://krisp.ai/developers/):
   ```bash
   pnpm add krisp-audio-node-sdk
   ```
2. **License key**:
   ```bash
   export KRISP_VIVA_SDK_LICENSE_KEY=your-license-key-here
   ```
3. **Noise-reduction model** — a `.kef` model file from Krisp:
   ```bash
   export KRISP_VIVA_FILTER_MODEL_PATH=/path/to/noise_model.kef
   ```

### Usage

Select the license backend by passing `authProvider`. Both the model path and
the license key come from the environment variables above (read by the native
SDK), so `krispLicense()` takes no arguments:

```ts
import * as krisp from '@livekit/agents-plugin-krisp';

const noiseCancellation = krisp.vivaFilter({
  authProvider: krisp.auth.krispLicense(),
  noiseSuppressionLevel: 100,
});
```

## Troubleshooting

### `@livekit/plugins-krisp-viva-internal` is missing

The default (LiveKit Cloud) backend is bundled as a dependency. If it reports as missing, the install is likely broken — reinstall the plugin, or fall back to the [Krisp license auth](#alternative-krisp-license-auth) path.

### "krisp-audio-node-sdk is not installed" _(license auth only)_

Install the public Krisp Node SDK (`pnpm add krisp-audio-node-sdk`), or use the default `auth.livekitCloud()` provider.

### "Krisp model path is required" / "Krisp model file not found" _(license auth only)_

```bash
export KRISP_VIVA_FILTER_MODEL_PATH=/path/to/model.kef
```

### "Unsupported sample rate"

Supported: 8000, 16000, 24000, 32000, 44100, 48000 Hz.

## License

The source code in this package (`@livekit/agents-plugin-krisp`) is licensed under the **Apache-2.0** license.

The **default backend** is a separate, closed-source package (`@livekit/plugins-krisp-viva-internal`) installed automatically as a dependency. It is **proprietary** and distributed under the [LiveKit Terms of Service](https://livekit.io/legal/terms-of-service). That package bundles the Krisp VIVA SDK along with its third-party open-source components.

The **Krisp license alternative** (`KrispLicenseAuthProvider`) instead needs a manual install of the proprietary `krisp-audio-node-sdk` together with your own Krisp license key and model file, governed by your agreement with [Krisp](https://krisp.ai).
