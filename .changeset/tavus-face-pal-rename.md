---
'@livekit/agents-plugin-tavus': patch
---

Align the Tavus plugin with the new face/pal API: `faceId`/`palId` options and `TAVUS_FACE_ID`/`TAVUS_PAL_ID` env vars, sending `face_id`/`pal_id` on the wire and auto-creating pals via `/v2/pals` (`createPal`). The old `replicaId`/`personaId` options, `TAVUS_REPLICA_ID`/`TAVUS_PERSONA_ID` env vars, and `createPersona()` keep working as deprecated aliases.
