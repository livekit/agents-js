---
'@livekit/agents': patch
---

Fix multiple critical bugs and enhance child process memory monitoring

## Bug Fixes
- **proc_pool.ts**: Fix `splice()` incorrectly removing all elements instead of one
- **job_proc_lazy_main.ts**: Fix `randomUUID` missing function call parentheses  
- **vad.ts**: Fix missing `inferenceDurationTotal` accumulation
- **llm.ts**: Fix potential division by zero in `tokensPerSecond` calculation
- **audio_recognition.ts**: Fix `sampleRate` never being assigned (prevents silence injection)
- **job.ts**: Add documentation explaining static field safety in child processes
- **supervised_proc.ts**: Improve memory monitoring system by switching from parent process monitoring to child process monitoring using pidusage library

## Dependencies
- Added `pidusage@^3.0.2` for cross-platform process monitoring
- Added `@types/pidusage@^2.0.5` for TypeScript support
