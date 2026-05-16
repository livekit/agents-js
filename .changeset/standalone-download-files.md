---
'@livekit/agents': patch
---

feat(agents): add `livekit-agents download-files` command for Docker layer caching

Adds a standalone CLI (`npx livekit-agents download-files`) that discovers installed
`@livekit/agents-plugin-*` packages and downloads their asset files without loading
the user's agent code.