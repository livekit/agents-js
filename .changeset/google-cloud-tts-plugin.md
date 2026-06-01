---
"@livekit/agents-plugin-google-cloud": patch
---

feat: add Google Cloud Text-to-Speech plugin

Ports the Google Cloud TTS integration from the Python SDK, supporting both
streaming (via gRPC bidirectional streaming) and non-streaming synthesis.
Uses @google-cloud/text-to-speech client library with credentials from
GOOGLE_TTS_CREDENTIALS_JSON env var or Application Default Credentials.
