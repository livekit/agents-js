---
'@livekit/agents-plugin-google': patch
---

Upgrade `@google/genai` to 2.x and seed the initial chat context of Gemini 3.x live sessions with its original roles.

Models whose chat context cannot be updated mid-session (the 3.x live models) close the socket on a prefill containing `model` turns, so an initial context had to be flattened into `user` turns to survive. Those sessions now send `historyConfig.initialHistoryInClientContent`, which tells the server the leading `clientContent` is history, and the prefill keeps its `user`/`assistant` roles.
