# CLAUDE.md

Configuration for turn-taking behavior: turn detection, endpointing, and interruption management.

## Structure

- **`turn_handling.ts`** — `TurnHandlingOptions` combining `turnDetection`, `endpointing`, and `interruption` configs. Also defines `InternalTurnHandlingOptions` (fully-resolved version with defaults).
- **`endpointing.ts`** — `EndpointingOptions`: `mode` ('fixed' | 'dynamic'), `minDelay` (500ms), `maxDelay` (3000ms).
- **`interruption.ts`** — `InterruptionOptions`: `enabled`, `mode` ('adaptive' | 'vad' | false), `minDuration`, `minWords`, `discardAudioIfUninterruptible`, `falseInterruptionTimeout`, `resumeFalseInterruption`.
- **`utils.ts`** — `migrateLegacyOptions()` converts deprecated flat fields to nested `turnHandling` structure. `mergeWithDefaults()` applies defaults.

## Turn Detection Modes

`TurnDetectionMode = 'stt' | 'vad' | 'realtime_llm' | 'manual' | _TurnDetector`

If undefined, `AgentActivity` auto-selects: RealtimeModel → VAD → STT → manual.

## Non-Obvious Patterns

- **`undefined` vs `false` semantics**: `interruption.mode: undefined` = auto-detect. `interruption.mode: false` = disabled entirely. These are distinct and checked with strict `!== false`.
- **Legacy migration**: Old flat fields (`allowInterruptions`, `minInterruptionDuration`, `minEndpointingDelay`, etc.) are still accepted. Precedence: explicit `turnHandling` > `options.*` > `voiceOptions.*` > defaults.
- **Non-cloneable turnDetection**: Custom `_TurnDetector` class instances are excluded from `structuredClone()` (would lose prototype) and restored separately after cloning.
- **Endpointing additivity**: In STT mode, `minDelay` is additive with the provider's own end-of-speech signal delay. Can compound delays unexpectedly.
- **False interruption flow**: If user interrupts then goes silent, `falseInterruptionTimeout` (2s default) fires `agentFalseInterruption` event. If `resumeFalseInterruption: true`, agent speech resumes automatically.
- **Merge is shallow spread, not deep**: `mergeWithDefaults()` uses object spread. Partial `endpointing` or `interruption` objects are filled from defaults field-by-field, not replaced wholesale.
