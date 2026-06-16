---
'@livekit/agents': patch
---

Console mode parity fixes for the `lk agent console` flow: run registered inference runners (e.g. the livekit turn detector) in a supervised child process instead of failing, and write `--record` output (`audio.ogg` + `session_report.json`) to a local `console-recordings/session-<timestamp>/` directory like python, instead of a temp dir with no report.
