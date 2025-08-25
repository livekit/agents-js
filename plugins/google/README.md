<!--
SPDX-FileCopyrightText: 2025 LiveKit, Inc.

SPDX-License-Identifier: Apache-2.0
-->

# LiveKit Agents Google Plugin

This plugin provides Google Gemini LLM support for LiveKit Node Agents using the new unified `@google/genai` SDK.

## Installation

```bash
npm install @livekit/agents-plugin-google
```

## Usage

### Basic Setup

```typescript
import { LLM } from '@livekit/agents-plugin-google';

// Using Google AI Studio (API Key)
const llm = new LLM({
  model: 'gemini-1.5-flash',
  apiKey: 'your-api-key', // or set GOOGLE_API_KEY env var
});

// Using Vertex AI
const llm = new LLM({
  model: 'gemini-1.5-pro',
  vertexai: true,
  project: 'your-project-id', // or set GOOGLE_CLOUD_PROJECT env var
  location: 'us-central1', // or set GOOGLE_CLOUD_LOCATION env var
});
```

To use the Gemini realtime model or TTS (Beta)

```typescript
import * as google from '@livekit/agents-plugin-google';

const realtimeModel = new google.beta.realtime.RealtimeModel()
const geminiTTS = new google.beta.TTS(),
```

### Environment Variables

- `GOOGLE_API_KEY` or `GOOGLE_GENAI_API_KEY`: Your Google AI Studio API key
- `GOOGLE_GENAI_USE_VERTEXAI`: Set to `true` or `1` to enable Vertex AI
- `GOOGLE_CLOUD_PROJECT`: Your Google Cloud project ID (for Vertex AI)
- `GOOGLE_CLOUD_LOCATION`: Your preferred location (default: `us-central1`)

### Supported Models

- `gemini-1.5-pro` - Most capable model
- `gemini-1.5-flash` - Fast and efficient
- `gemini-1.5-flash-8b` - Ultra-fast lightweight model
- `gemini-2.0-flash-exp` - Latest experimental model
- And more (see models.ts for full list)

### Advanced Configuration

```typescript
const llm = new LLM({
  model: 'gemini-1.5-pro',
  temperature: 0.7,
  maxOutputTokens: 2048,
  topP: 0.8,
  topK: 40,
  toolChoice: 'auto',
});
```

## Authentication

### Google AI Studio

Set your API key via environment variable or constructor option:

```bash
export GOOGLE_API_KEY=your-api-key
```

### Vertex AI

For Vertex AI, ensure you have:

1. Google Cloud CLI installed and authenticated
2. Vertex AI API enabled in your project
3. Proper authentication configured (Application Default Credentials)

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project-id
export GOOGLE_GENAI_USE_VERTEXAI=true
```

## License

Apache 2.0
