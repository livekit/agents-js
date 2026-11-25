---
'@livekit/agents': patch
---

fix(llm): treat a null tool argument as absent for optional Zod fields

`zodSchemaToJsonSchema` targets `openAi`, which rewrites an `.optional()` property
into a required nullable one because a strict tool schema must list every property
in `required`. That leaves null as the only way for a model to say "not provided",
but tool arguments are validated against the original Zod schema, where
`.optional()` accepts undefined and rejects null. Any tool with a bare
`.optional()` field therefore failed with `Arguments parsing failed` as soon as the
model filled the key in with null — reliably under `strictToolSchema`, since the
decoder then enforces `required`.

Defaulted fields already round-tripped through the null sentinel resolved in
`injectSchemaDefaults`. This extends the same inverse mapping to optional fields:
a null is dropped when the property is absent from `required` and its schema does
not allow null, so Zod sees undefined. Defaults still win, and a property that is
required or genuinely nullable keeps its null so real contract violations still
surface.
