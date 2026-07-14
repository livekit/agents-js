---
'@livekit/agents': patch
---

Port the built-in data-capture workflows from python livekit-agents (`beta/workflows`) to the stable `workflows` namespace: `GetEmailTask`, `GetNameTask`, `GetPhoneNumberTask`, `GetDOBTask`, `GetAddressTask`, `GetDtmfTask`, and `GetCreditCardTask` (with `create*Task` functional variants). Includes the `DtmfEvent` enum with `formatDtmf`/`dtmfEventToCode` helpers, and `TaskGroup.add` now accepts factories for typed `AgentTask<T>` results.
