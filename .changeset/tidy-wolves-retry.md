---
'@livekit/agents-plugin-anthropic': patch
---

Disable Anthropic SDK retries by default so the framework owns retry behavior.

The Anthropic SDK client created by the plugin is now constructed with `maxRetries: 0`, so the vendor SDK no longer retries requests on its own. Retries are owned entirely by the framework's `connOptions`, which avoids compounding vendor retries with framework retries. Pass `maxRetries` to `LLM` to restore vendor-side retries, or inject your own `client` — an injected client's retry policy is left untouched.
