<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# Gradium plugin for LiveKit Agents

Support for [Gradium](https://gradium.ai/)-hosted speech-to-text models.

## Installation

```bash
pnpm add @livekit/agents-plugin-gradium
```

## Pre-requisites

Set your Gradium API key as `GRADIUM_API_KEY`, or pass it to `STT` as `apiKey`.
The model endpoint can be configured with `GRADIUM_MODEL_ENDPOINT` or `modelEndpoint`.
