<!--
SPDX-FileCopyrightText: 2026 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# @livekit/agents-plugin-mistral (deprecated)

> **This package is deprecated.** Please use
> [`@livekit/agents-plugin-mistralai`](https://www.npmjs.com/package/@livekit/agents-plugin-mistralai)
> instead.

This package is a thin compatibility wrapper that re-exports the LLM from
`@livekit/agents-plugin-mistralai`. It will be removed in a future release.

## Migration

```diff
- import * as mistral from '@livekit/agents-plugin-mistral';
+ import * as mistral from '@livekit/agents-plugin-mistralai';
```

```diff
- npm install @livekit/agents-plugin-mistral
+ npm install @livekit/agents-plugin-mistralai
```

The new package also adds STT and TTS support. See the
[`@livekit/agents-plugin-mistralai` README](../mistralai/README.md) for full
usage details.
