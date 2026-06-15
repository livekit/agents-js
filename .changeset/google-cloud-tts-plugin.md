---
"@livekit/agents-plugin-google-cloud": patch
"@livekit/agents": patch
---

feat: add Google Cloud Text-to-Speech plugin

Ports the Google Cloud TTS integration from the Python SDK, supporting both
streaming (via gRPC bidirectional streaming) and non-streaming synthesis.
Uses @google-cloud/text-to-speech client with standard Google Cloud auth
(credentials object, keyFilename, GOOGLE_APPLICATION_CREDENTIALS, or ADC).
