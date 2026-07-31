// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Range contracts for every numeric option a user can pass into the framework,
 * expressed as leading `console.assert` calls that `@chenglou/freerange`
 * analyzes statically (`pnpm fr`, `pnpm fr:audit`).
 *
 * Three constraints shape this file:
 *
 * - A leading `console.assert` is a caller requirement, and may only compare
 *   one parameter against a fixed number, so every bound is a literal or a
 *   module constant. Bounds cannot be parameters.
 * - Requirements propagate only within one file, so the `check*OptionRanges`
 *   aggregators live next to the `checked*` helpers they call. Call sites are
 *   constructors and methods, which freerange does not analyze either way, so
 *   importing an aggregator loses nothing.
 * - Freerange cannot read a union-typed or mapped-type field, and reading one
 *   makes the whole function unanalyzable. The option shapes below therefore
 *   spell out only the ranged numeric fields.
 */

// --- contracts, grouped by the range they assert ---------------------------
//
// One function per distinct range. Each lists the options that carry it, so a
// second name for the same bounds cannot creep back in.

/** Durations, timeouts and selection weights. */
function checkedNonNegative(value: number): number {
  console.assert(value >= 0);
  return value;
}

/** Gain multipliers: `Math.log10` is `-Infinity` at 0 and `NaN` below it. */
function checkedPositive(value: number): number {
  console.assert(value > 0);
  return value;
}

/**
 * Probabilities, confidences and sensitivities: interruption `threshold`,
 * endpointing `alpha`, `top_p`, `vad_threshold`, `speaker_sensitivity`,
 * `end_of_turn_confidence_threshold`, `voice_focus_threshold`, `min_volume`,
 * and the turn-detector thresholds.
 */
export function checkedZeroToOne(value: number): number {
  console.assert(value >= 0);
  console.assert(value <= 1);
  return value;
}

/** VAD sigmoid activation and deactivation thresholds. */
function checkedPositiveAtMostOne(value: number): number {
  console.assert(value > 0);
  console.assert(value <= 1);
  return value;
}

/** LLM sampling `temperature`. */
function checkedZeroToTwo(value: number): number {
  console.assert(value >= 0);
  console.assert(value <= 2);
  return value;
}

/** LLM `presence_penalty` and `frequency_penalty`. */
function checkedMinusTwoToTwo(value: number): number {
  console.assert(value >= -2);
  console.assert(value <= 2);
  return value;
}

/** Interruption `maxAudioDurationInS`: the server caps the window at 3s. */
function checkedZeroToThree(value: number): number {
  console.assert(value >= 0);
  console.assert(value <= 3);
  return value;
}

/** xAI STT `endpointing`, in milliseconds. */
function checkedZeroTo5000(value: number): number {
  console.assert(value >= 0);
  console.assert(value <= 5000);
  return value;
}

/** Cartesia `turn_start_threshold` and Deepgram Flux `eot_threshold`. */
function checked0p5To0p9(value: number): number {
  console.assert(value >= 0.5);
  console.assert(value <= 0.9);
  return value;
}

/** Deepgram Flux `eager_eot_threshold`. */
function checked0p3To0p9(value: number): number {
  console.assert(value >= 0.3);
  console.assert(value <= 0.9);
  return value;
}

/** Cartesia `turn_eager_end_threshold`. */
function checked0p3To0p6(value: number): number {
  console.assert(value >= 0.3);
  console.assert(value <= 0.6);
  return value;
}

/** Cartesia `turn_end_threshold`. */
function checked0p05To0p5(value: number): number {
  console.assert(value >= 0.05);
  console.assert(value <= 0.5);
  return value;
}

/** Speechmatics `max_delay`, in seconds. */
function checked0p7To4(value: number): number {
  console.assert(value >= 0.7);
  console.assert(value <= 4);
  return value;
}

/** Cartesia `turn_end_timeout_ms`. */
function checked640To11200(value: number): number {
  console.assert(value >= 640);
  console.assert(value <= 11200);
  return value;
}

/** Counts of things there may be none of: tool steps, idle processes, words. */
function checkedIntegerNonNegative(value: number): number {
  console.assert(Number.isInteger(value));
  console.assert(value >= 0);
  return value;
}

/** Counts of things there must be one of: tokens, speakers, detection frames. */
function checkedIntegerAtLeastOne(value: number): number {
  console.assert(Number.isInteger(value));
  console.assert(value >= 1);
  return value;
}

/** LLM `top_logprobs`: the API returns at most 20 per position. */
function checkedIntegerZeroTo20(value: number): number {
  console.assert(Number.isInteger(value));
  console.assert(value >= 0);
  console.assert(value <= 20);
  return value;
}

/** Inworld `voice_profile_top_n`: labels per category. */
function checkedIntegerOneTo20(value: number): number {
  console.assert(Number.isInteger(value));
  console.assert(value >= 1);
  console.assert(value <= 20);
  return value;
}

/** TCP ports; 0 asks the OS to pick one. */
function checkedIntegerZeroTo65535(value: number): number {
  console.assert(Number.isInteger(value));
  console.assert(value >= 0);
  console.assert(value <= 65535);
  return value;
}

// --- inference.VAD --------------------------------------------------------

/** Caller requirements for the ranged `inference.VADOptions` fields. */
export function checkVADOptionRanges(opts: {
  activationThreshold?: number;
  deactivationThreshold?: number;
  minSpeechDuration?: number;
  minSilenceDuration?: number;
  prefixPaddingDuration?: number;
  maxBufferedSpeech?: number;
}): void {
  if (opts.activationThreshold !== undefined) {
    checkedPositiveAtMostOne(opts.activationThreshold);
  }
  if (opts.deactivationThreshold !== undefined) {
    checkedPositiveAtMostOne(opts.deactivationThreshold);
  }
  if (opts.minSpeechDuration !== undefined) checkedNonNegative(opts.minSpeechDuration);
  if (opts.minSilenceDuration !== undefined) checkedNonNegative(opts.minSilenceDuration);
  if (opts.prefixPaddingDuration !== undefined) checkedNonNegative(opts.prefixPaddingDuration);
  if (opts.maxBufferedSpeech !== undefined) checkedNonNegative(opts.maxBufferedSpeech);
}

// --- AgentSession ---------------------------------------------------------

/** Caller requirements for the ranged `AgentSessionOptions` fields. */
export function checkAgentSessionOptionRanges(opts: {
  maxToolSteps?: number;
  userAwayTimeout?: number | null;
  aecWarmupDuration?: number | null;
  ttsReadIdleTimeout?: number;
  forwardAudioIdleTimeout?: number;
}): void {
  if (opts.maxToolSteps !== undefined) checkedIntegerNonNegative(opts.maxToolSteps);
  if (opts.userAwayTimeout !== undefined && opts.userAwayTimeout !== null) {
    checkedNonNegative(opts.userAwayTimeout);
  }
  if (opts.aecWarmupDuration !== undefined && opts.aecWarmupDuration !== null) {
    checkedNonNegative(opts.aecWarmupDuration);
  }
  if (opts.ttsReadIdleTimeout !== undefined) checkedNonNegative(opts.ttsReadIdleTimeout);
  if (opts.forwardAudioIdleTimeout !== undefined) checkedNonNegative(opts.forwardAudioIdleTimeout);
}

/**
 * Caller requirements for the ranged `TurnHandlingOptions` fields.
 *
 * `interruption.backchannelBoundary` is omitted: it is a
 * `number | [number, number] | null` union, which freerange cannot read.
 */
export function checkTurnHandlingOptionRanges(config: {
  endpointing?: { minDelay?: number; maxDelay?: number; alpha?: number };
  interruption?: {
    minDuration?: number;
    minWords?: number;
    falseInterruptionTimeout?: number;
  };
  preemptiveGeneration?: { maxSpeechDuration?: number; maxRetries?: number };
  userTurnLimit?: { maxWords?: number | null; maxDuration?: number | null };
}): void {
  const endpointing = config.endpointing;
  if (endpointing !== undefined) {
    if (endpointing.minDelay !== undefined) checkedNonNegative(endpointing.minDelay);
    if (endpointing.maxDelay !== undefined) checkedNonNegative(endpointing.maxDelay);
    if (endpointing.alpha !== undefined) checkedZeroToOne(endpointing.alpha);
  }

  const interruption = config.interruption;
  if (interruption !== undefined) {
    if (interruption.minDuration !== undefined) checkedNonNegative(interruption.minDuration);
    if (interruption.minWords !== undefined) checkedIntegerNonNegative(interruption.minWords);
    if (interruption.falseInterruptionTimeout !== undefined) {
      checkedNonNegative(interruption.falseInterruptionTimeout);
    }
  }

  const preemptive = config.preemptiveGeneration;
  if (preemptive !== undefined) {
    if (preemptive.maxSpeechDuration !== undefined)
      checkedNonNegative(preemptive.maxSpeechDuration);
    if (preemptive.maxRetries !== undefined) checkedIntegerNonNegative(preemptive.maxRetries);
  }

  const userTurnLimit = config.userTurnLimit;
  if (userTurnLimit !== undefined) {
    const maxWords = userTurnLimit.maxWords;
    if (maxWords !== undefined && maxWords !== null) checkedIntegerNonNegative(maxWords);
    const maxDuration = userTurnLimit.maxDuration;
    if (maxDuration !== undefined && maxDuration !== null) checkedNonNegative(maxDuration);
  }
}

// --- BackgroundAudioPlayer ------------------------------------------------

/** Caller requirements for the ranged `AudioConfig` fields. */
export function checkAudioConfigRanges(config: { volume?: number; probability?: number }): void {
  if (config.volume !== undefined) checkedPositive(config.volume);
  if (config.probability !== undefined) checkedNonNegative(config.probability);
}

// --- ServerOptions --------------------------------------------------------

/**
 * Caller requirements for the ranged `ServerOptions` fields.
 *
 * `loadThreshold` is absent on purpose: `Infinity` disables load-based
 * availability, and a plain `number` contract requires a finite value.
 */
export function checkServerOptionRanges(opts: {
  numIdleProcesses?: number;
  drainTimeout?: number;
  shutdownProcessTimeout?: number;
  initializeProcessTimeout?: number;
  maxRetry?: number;
  port?: number;
  jobMemoryWarnMB?: number;
  jobMemoryLimitMB?: number;
}): void {
  if (opts.numIdleProcesses !== undefined) checkedIntegerNonNegative(opts.numIdleProcesses);
  if (opts.drainTimeout !== undefined) checkedNonNegative(opts.drainTimeout);
  if (opts.shutdownProcessTimeout !== undefined) checkedNonNegative(opts.shutdownProcessTimeout);
  if (opts.initializeProcessTimeout !== undefined)
    checkedNonNegative(opts.initializeProcessTimeout);
  if (opts.maxRetry !== undefined) checkedIntegerNonNegative(opts.maxRetry);
  if (opts.port !== undefined) checkedIntegerZeroTo65535(opts.port);
  if (opts.jobMemoryWarnMB !== undefined) checkedIntegerNonNegative(opts.jobMemoryWarnMB);
  if (opts.jobMemoryLimitMB !== undefined) checkedIntegerNonNegative(opts.jobMemoryLimitMB);
}

// --- adaptive interruption detection --------------------------------------

/** Caller requirements for the ranged `InterruptionOptions` fields. */
export function checkInterruptionOptionRanges(options: {
  threshold?: number;
  maxAudioDurationInS?: number;
  audioPrefixDurationInS?: number;
  detectionIntervalInS?: number;
  inferenceTimeout?: number;
  minInterruptionDurationInS?: number;
  minFrames?: number;
}): void {
  if (options.threshold !== undefined) checkedZeroToOne(options.threshold);
  if (options.maxAudioDurationInS !== undefined) {
    checkedZeroToThree(options.maxAudioDurationInS);
  }
  if (options.audioPrefixDurationInS !== undefined) {
    checkedNonNegative(options.audioPrefixDurationInS);
  }
  if (options.detectionIntervalInS !== undefined) checkedNonNegative(options.detectionIntervalInS);
  if (options.inferenceTimeout !== undefined) checkedNonNegative(options.inferenceTimeout);
  if (options.minInterruptionDurationInS !== undefined) {
    checkedNonNegative(options.minInterruptionDurationInS);
  }
  // a detection needs at least one 25ms frame
  if (options.minFrames !== undefined) checkedIntegerAtLeastOne(options.minFrames);
}

// --- turn detection (end of turn) -----------------------------------------

// --- inference.LLM --------------------------------------------------------

/** Caller requirements for the ranged `ChatCompletionOptions` fields. */
export function checkChatCompletionOptionRanges(options: {
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  n?: number;
  top_logprobs?: number;
}): void {
  if (options.temperature !== undefined) checkedZeroToTwo(options.temperature);
  if (options.top_p !== undefined) checkedZeroToOne(options.top_p);
  if (options.presence_penalty !== undefined) checkedMinusTwoToTwo(options.presence_penalty);
  if (options.frequency_penalty !== undefined) checkedMinusTwoToTwo(options.frequency_penalty);
  if (options.max_tokens !== undefined) checkedIntegerAtLeastOne(options.max_tokens);
  if (options.max_completion_tokens !== undefined) {
    checkedIntegerAtLeastOne(options.max_completion_tokens);
  }
  if (options.n !== undefined) checkedIntegerAtLeastOne(options.n);
  if (options.top_logprobs !== undefined) checkedIntegerZeroTo20(options.top_logprobs);
}

// --- inference.STT provider options ---------------------------------------

/** The ranged numeric fields across every provider's STT option interface. */
export type RangedSTTModelOptions = {
  // Cartesia
  turn_start_threshold?: number;
  turn_eager_end_threshold?: number;
  turn_end_threshold?: number;
  turn_end_timeout_ms?: number;
  min_volume?: number;
  max_silence_duration_secs?: number;
  // Deepgram, Deepgram Flux
  endpointing?: number;
  eager_eot_threshold?: number;
  eot_threshold?: number;
  eot_timeout_ms?: number;
  // AssemblyAI, Inworld
  end_of_turn_confidence_threshold?: number;
  min_end_of_turn_silence_when_confident?: number;
  max_turn_silence?: number;
  voice_focus_threshold?: number;
  inactivity_timeout_seconds?: number;
  voice_profile_top_n?: number;
  vad_threshold?: number;
  // Speechmatics
  max_delay?: number;
  speaker_sensitivity?: number;
  max_speakers?: number;
  end_of_utterance_silence_trigger?: number;
};

function checkCartesiaOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.turn_start_threshold !== undefined) {
    checked0p5To0p9(modelOptions.turn_start_threshold);
  }
  if (modelOptions.turn_eager_end_threshold !== undefined) {
    checked0p3To0p6(modelOptions.turn_eager_end_threshold);
  }
  if (modelOptions.turn_end_threshold !== undefined) {
    checked0p05To0p5(modelOptions.turn_end_threshold);
  }
  if (modelOptions.turn_end_timeout_ms !== undefined) {
    checked640To11200(modelOptions.turn_end_timeout_ms);
  }
  if (modelOptions.min_volume !== undefined) checkedZeroToOne(modelOptions.min_volume);
  if (modelOptions.max_silence_duration_secs !== undefined) {
    checkedNonNegative(modelOptions.max_silence_duration_secs);
  }
}

function checkDeepgramFluxOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.eager_eot_threshold !== undefined) {
    checked0p3To0p9(modelOptions.eager_eot_threshold);
  }
  if (modelOptions.eot_threshold !== undefined) {
    checked0p5To0p9(modelOptions.eot_threshold);
  }
  if (modelOptions.eot_timeout_ms !== undefined) checkedNonNegative(modelOptions.eot_timeout_ms);
}

function checkDeepgramOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.endpointing !== undefined) checkedNonNegative(modelOptions.endpointing);
}

function checkAssemblyAIOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.end_of_turn_confidence_threshold !== undefined) {
    checkedZeroToOne(modelOptions.end_of_turn_confidence_threshold);
  }
  if (modelOptions.min_end_of_turn_silence_when_confident !== undefined) {
    checkedNonNegative(modelOptions.min_end_of_turn_silence_when_confident);
  }
  if (modelOptions.max_turn_silence !== undefined)
    checkedNonNegative(modelOptions.max_turn_silence);
  if (modelOptions.voice_focus_threshold !== undefined) {
    checkedZeroToOne(modelOptions.voice_focus_threshold);
  }
}

function checkXaiOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.endpointing !== undefined) checkedZeroTo5000(modelOptions.endpointing);
}

function checkSpeechmaticsOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.max_delay !== undefined) checked0p7To4(modelOptions.max_delay);
  if (modelOptions.speaker_sensitivity !== undefined) {
    checkedZeroToOne(modelOptions.speaker_sensitivity);
  }
  if (modelOptions.max_speakers !== undefined) {
    checkedIntegerAtLeastOne(modelOptions.max_speakers);
  }
  if (modelOptions.end_of_utterance_silence_trigger !== undefined) {
    checkedNonNegative(modelOptions.end_of_utterance_silence_trigger);
  }
}

function checkInworldSTTOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.voice_profile_top_n !== undefined) {
    checkedIntegerOneTo20(modelOptions.voice_profile_top_n);
  }
  if (modelOptions.inactivity_timeout_seconds !== undefined) {
    checkedNonNegative(modelOptions.inactivity_timeout_seconds);
  }
  if (modelOptions.end_of_turn_confidence_threshold !== undefined) {
    checkedZeroToOne(modelOptions.end_of_turn_confidence_threshold);
  }
  if (modelOptions.min_end_of_turn_silence_when_confident !== undefined) {
    checkedNonNegative(modelOptions.min_end_of_turn_silence_when_confident);
  }
  if (modelOptions.vad_threshold !== undefined) checkedZeroToOne(modelOptions.vad_threshold);
}

/**
 * Route the user's `modelOptions` to the option contracts of the provider that
 * will receive them. The routing itself is outside freerange's analyzed subset
 * (`String.startsWith`), so the per-provider functions above hold the contracts.
 */
export function checkSTTModelOptionRanges(
  model: string | undefined,
  modelOptions: RangedSTTModelOptions,
): void {
  if (model === undefined) return;
  if (model.startsWith('cartesia/')) return checkCartesiaOptionRanges(modelOptions);
  if (model.startsWith('deepgram/flux')) return checkDeepgramFluxOptionRanges(modelOptions);
  if (model.startsWith('deepgram/')) return checkDeepgramOptionRanges(modelOptions);
  if (model.startsWith('assemblyai/')) return checkAssemblyAIOptionRanges(modelOptions);
  if (model.startsWith('xai/')) return checkXaiOptionRanges(modelOptions);
  if (model.startsWith('speechmatics/')) return checkSpeechmaticsOptionRanges(modelOptions);
  if (model.startsWith('inworld/')) return checkInworldSTTOptionRanges(modelOptions);
}
