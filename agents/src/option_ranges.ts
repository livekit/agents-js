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

// --- shared domains -------------------------------------------------------

/** Probabilities, confidences and sensitivities are 0..1. */
function checkedProbability(value: number): number {
  console.assert(value >= 0);
  console.assert(value <= 1);
  return value;
}

/** Durations and timeouts are never negative, whatever their unit. */
function checkedDuration(value: number): number {
  console.assert(value >= 0);
  return value;
}

/** Counts are non-negative integers. */
function checkedCount(value: number): number {
  console.assert(Number.isInteger(value));
  console.assert(value >= 0);
  return value;
}

/** Counts of things there must be at least one of. */
function checkedPositiveCount(value: number): number {
  console.assert(Number.isInteger(value));
  console.assert(value >= 1);
  return value;
}

// --- inference.VAD --------------------------------------------------------

/** Sigmoid thresholds are probabilities: positive, at most 1. */
function checkedActivationThreshold(value: number): number {
  console.assert(value > 0);
  console.assert(value <= 1);
  return value;
}

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
    checkedActivationThreshold(opts.activationThreshold);
  }
  if (opts.deactivationThreshold !== undefined) {
    checkedActivationThreshold(opts.deactivationThreshold);
  }
  if (opts.minSpeechDuration !== undefined) checkedDuration(opts.minSpeechDuration);
  if (opts.minSilenceDuration !== undefined) checkedDuration(opts.minSilenceDuration);
  if (opts.prefixPaddingDuration !== undefined) checkedDuration(opts.prefixPaddingDuration);
  if (opts.maxBufferedSpeech !== undefined) checkedDuration(opts.maxBufferedSpeech);
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
  if (opts.maxToolSteps !== undefined) checkedCount(opts.maxToolSteps);
  if (opts.userAwayTimeout !== undefined && opts.userAwayTimeout !== null) {
    checkedDuration(opts.userAwayTimeout);
  }
  if (opts.aecWarmupDuration !== undefined && opts.aecWarmupDuration !== null) {
    checkedDuration(opts.aecWarmupDuration);
  }
  if (opts.ttsReadIdleTimeout !== undefined) checkedDuration(opts.ttsReadIdleTimeout);
  if (opts.forwardAudioIdleTimeout !== undefined) checkedDuration(opts.forwardAudioIdleTimeout);
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
    if (endpointing.minDelay !== undefined) checkedDuration(endpointing.minDelay);
    if (endpointing.maxDelay !== undefined) checkedDuration(endpointing.maxDelay);
    if (endpointing.alpha !== undefined) checkedProbability(endpointing.alpha);
  }

  const interruption = config.interruption;
  if (interruption !== undefined) {
    if (interruption.minDuration !== undefined) checkedDuration(interruption.minDuration);
    if (interruption.minWords !== undefined) checkedCount(interruption.minWords);
    if (interruption.falseInterruptionTimeout !== undefined) {
      checkedDuration(interruption.falseInterruptionTimeout);
    }
  }

  const preemptive = config.preemptiveGeneration;
  if (preemptive !== undefined) {
    if (preemptive.maxSpeechDuration !== undefined) checkedDuration(preemptive.maxSpeechDuration);
    if (preemptive.maxRetries !== undefined) checkedCount(preemptive.maxRetries);
  }

  const userTurnLimit = config.userTurnLimit;
  if (userTurnLimit !== undefined) {
    const maxWords = userTurnLimit.maxWords;
    if (maxWords !== undefined && maxWords !== null) checkedCount(maxWords);
    const maxDuration = userTurnLimit.maxDuration;
    if (maxDuration !== undefined && maxDuration !== null) checkedDuration(maxDuration);
  }
}

// --- BackgroundAudioPlayer ------------------------------------------------

/**
 * Volume is a gain multiplier. It must be positive: the playback path feeds it
 * to `Math.log10`, which is `-Infinity` at 0 and `NaN` below it.
 */
function checkedVolume(volume: number): number {
  console.assert(volume > 0);
  return volume;
}

/** Selection weights are non-negative; a zero weight is skipped. */
function checkedWeight(weight: number): number {
  console.assert(weight >= 0);
  return weight;
}

/** Caller requirements for the ranged `AudioConfig` fields. */
export function checkAudioConfigRanges(config: { volume?: number; probability?: number }): void {
  if (config.volume !== undefined) checkedVolume(config.volume);
  if (config.probability !== undefined) checkedWeight(config.probability);
}

// --- ServerOptions --------------------------------------------------------

/** TCP ports are integers in 0..65535; 0 asks the OS to pick one. */
function checkedPort(value: number): number {
  console.assert(Number.isInteger(value));
  console.assert(value >= 0);
  console.assert(value <= 65535);
  return value;
}

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
  if (opts.numIdleProcesses !== undefined) checkedCount(opts.numIdleProcesses);
  if (opts.drainTimeout !== undefined) checkedDuration(opts.drainTimeout);
  if (opts.shutdownProcessTimeout !== undefined) checkedDuration(opts.shutdownProcessTimeout);
  if (opts.initializeProcessTimeout !== undefined) checkedDuration(opts.initializeProcessTimeout);
  if (opts.maxRetry !== undefined) checkedCount(opts.maxRetry);
  if (opts.port !== undefined) checkedPort(opts.port);
  if (opts.jobMemoryWarnMB !== undefined) checkedCount(opts.jobMemoryWarnMB);
  if (opts.jobMemoryLimitMB !== undefined) checkedCount(opts.jobMemoryLimitMB);
}

// --- adaptive interruption detection --------------------------------------

/** The server caps the interruption analysis window at 3 seconds. */
function checkedMaxAudioDurationInS(value: number): number {
  console.assert(value >= 0);
  console.assert(value <= 3);
  return value;
}

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
  if (options.threshold !== undefined) checkedProbability(options.threshold);
  if (options.maxAudioDurationInS !== undefined) {
    checkedMaxAudioDurationInS(options.maxAudioDurationInS);
  }
  if (options.audioPrefixDurationInS !== undefined) {
    checkedDuration(options.audioPrefixDurationInS);
  }
  if (options.detectionIntervalInS !== undefined) checkedDuration(options.detectionIntervalInS);
  if (options.inferenceTimeout !== undefined) checkedDuration(options.inferenceTimeout);
  if (options.minInterruptionDurationInS !== undefined) {
    checkedDuration(options.minInterruptionDurationInS);
  }
  // a detection needs at least one 25ms frame
  if (options.minFrames !== undefined) checkedPositiveCount(options.minFrames);
}

// --- turn detection (end of turn) -----------------------------------------

/** Turn-detector thresholds are probabilities: 0..1. */
export function checkedEotThreshold(threshold: number): number {
  console.assert(threshold >= 0);
  console.assert(threshold <= 1);
  return threshold;
}

// --- inference.LLM --------------------------------------------------------

/** Sampling temperature, as documented by the OpenAI-compatible API. */
function checkedTemperature(temperature: number): number {
  console.assert(temperature >= 0);
  console.assert(temperature <= 2);
  return temperature;
}

/** Presence and frequency penalties live in -2..2. */
function checkedPenalty(penalty: number): number {
  console.assert(penalty >= -2);
  console.assert(penalty <= 2);
  return penalty;
}

/** The API returns log-probabilities for at most 20 tokens per position. */
function checkedTopLogprobs(topLogprobs: number): number {
  console.assert(Number.isInteger(topLogprobs));
  console.assert(topLogprobs >= 0);
  console.assert(topLogprobs <= 20);
  return topLogprobs;
}

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
  if (options.temperature !== undefined) checkedTemperature(options.temperature);
  if (options.top_p !== undefined) checkedProbability(options.top_p);
  if (options.presence_penalty !== undefined) checkedPenalty(options.presence_penalty);
  if (options.frequency_penalty !== undefined) checkedPenalty(options.frequency_penalty);
  if (options.max_tokens !== undefined) checkedPositiveCount(options.max_tokens);
  if (options.max_completion_tokens !== undefined) {
    checkedPositiveCount(options.max_completion_tokens);
  }
  if (options.n !== undefined) checkedPositiveCount(options.n);
  if (options.top_logprobs !== undefined) checkedTopLogprobs(options.top_logprobs);
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

/** Cartesia turn-start threshold: 0.5-0.9. */
function checkedTurnStartThreshold(value: number): number {
  console.assert(value >= 0.5);
  console.assert(value <= 0.9);
  return value;
}

/** Cartesia eager turn-end threshold: 0.3-0.6. */
function checkedTurnEagerEndThreshold(value: number): number {
  console.assert(value >= 0.3);
  console.assert(value <= 0.6);
  return value;
}

/** Cartesia turn-end threshold: 0.05-0.5. */
function checkedTurnEndThreshold(value: number): number {
  console.assert(value >= 0.05);
  console.assert(value <= 0.5);
  return value;
}

/** Cartesia turn-end timeout: 640-11200 ms. */
function checkedTurnEndTimeoutMs(value: number): number {
  console.assert(value >= 640);
  console.assert(value <= 11200);
  return value;
}

/** Deepgram Flux eager end-of-turn threshold: 0.3-0.9. */
function checkedEagerEotThreshold(value: number): number {
  console.assert(value >= 0.3);
  console.assert(value <= 0.9);
  return value;
}

/** Deepgram Flux end-of-turn threshold: 0.5-0.9. */
function checkedFluxEotThreshold(value: number): number {
  console.assert(value >= 0.5);
  console.assert(value <= 0.9);
  return value;
}

/** xAI endpointing: 0-5000 ms. */
function checkedXaiEndpointingMs(value: number): number {
  console.assert(value >= 0);
  console.assert(value <= 5000);
  return value;
}

/** Speechmatics max delay: 0.7-4.0 seconds. */
function checkedSpeechmaticsMaxDelay(value: number): number {
  console.assert(value >= 0.7);
  console.assert(value <= 4);
  return value;
}

/** Inworld voice-profile labels per category: 1-20. */
function checkedVoiceProfileTopN(value: number): number {
  console.assert(Number.isInteger(value));
  console.assert(value >= 1);
  console.assert(value <= 20);
  return value;
}

function checkCartesiaOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.turn_start_threshold !== undefined) {
    checkedTurnStartThreshold(modelOptions.turn_start_threshold);
  }
  if (modelOptions.turn_eager_end_threshold !== undefined) {
    checkedTurnEagerEndThreshold(modelOptions.turn_eager_end_threshold);
  }
  if (modelOptions.turn_end_threshold !== undefined) {
    checkedTurnEndThreshold(modelOptions.turn_end_threshold);
  }
  if (modelOptions.turn_end_timeout_ms !== undefined) {
    checkedTurnEndTimeoutMs(modelOptions.turn_end_timeout_ms);
  }
  if (modelOptions.min_volume !== undefined) checkedProbability(modelOptions.min_volume);
  if (modelOptions.max_silence_duration_secs !== undefined) {
    checkedDuration(modelOptions.max_silence_duration_secs);
  }
}

function checkDeepgramFluxOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.eager_eot_threshold !== undefined) {
    checkedEagerEotThreshold(modelOptions.eager_eot_threshold);
  }
  if (modelOptions.eot_threshold !== undefined) {
    checkedFluxEotThreshold(modelOptions.eot_threshold);
  }
  if (modelOptions.eot_timeout_ms !== undefined) checkedDuration(modelOptions.eot_timeout_ms);
}

function checkDeepgramOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.endpointing !== undefined) checkedDuration(modelOptions.endpointing);
}

function checkAssemblyAIOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.end_of_turn_confidence_threshold !== undefined) {
    checkedProbability(modelOptions.end_of_turn_confidence_threshold);
  }
  if (modelOptions.min_end_of_turn_silence_when_confident !== undefined) {
    checkedDuration(modelOptions.min_end_of_turn_silence_when_confident);
  }
  if (modelOptions.max_turn_silence !== undefined) checkedDuration(modelOptions.max_turn_silence);
  if (modelOptions.voice_focus_threshold !== undefined) {
    checkedProbability(modelOptions.voice_focus_threshold);
  }
}

function checkXaiOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.endpointing !== undefined) checkedXaiEndpointingMs(modelOptions.endpointing);
}

function checkSpeechmaticsOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.max_delay !== undefined) checkedSpeechmaticsMaxDelay(modelOptions.max_delay);
  if (modelOptions.speaker_sensitivity !== undefined) {
    checkedProbability(modelOptions.speaker_sensitivity);
  }
  if (modelOptions.max_speakers !== undefined) {
    checkedPositiveCount(modelOptions.max_speakers);
  }
  if (modelOptions.end_of_utterance_silence_trigger !== undefined) {
    checkedDuration(modelOptions.end_of_utterance_silence_trigger);
  }
}

function checkInworldSTTOptionRanges(modelOptions: RangedSTTModelOptions): void {
  if (modelOptions.voice_profile_top_n !== undefined) {
    checkedVoiceProfileTopN(modelOptions.voice_profile_top_n);
  }
  if (modelOptions.inactivity_timeout_seconds !== undefined) {
    checkedDuration(modelOptions.inactivity_timeout_seconds);
  }
  if (modelOptions.end_of_turn_confidence_threshold !== undefined) {
    checkedProbability(modelOptions.end_of_turn_confidence_threshold);
  }
  if (modelOptions.min_end_of_turn_silence_when_confident !== undefined) {
    checkedDuration(modelOptions.min_end_of_turn_silence_when_confident);
  }
  if (modelOptions.vad_threshold !== undefined) checkedProbability(modelOptions.vad_threshold);
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
