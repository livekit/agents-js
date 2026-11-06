---
'@livekit/agents': patch
---

Drop a user turn skipped below `minWords` instead of keeping its words for the next trigger. Skipped backchannels ("Right." three times during one reply) no longer add up to `minWords` and interrupt the agent, and a skipped "Okay." no longer prefixes the next committed turn ("Okay. Stop."). Words the user adds before the skip is decided still count together, so a continuous "Wait. hold on" still interrupts.
