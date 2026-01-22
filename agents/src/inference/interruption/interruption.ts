import { slidingWindowMinMax } from '../utils.js';
import { FRAME_DURATION_IN_S, MIN_INTERRUPTION_DURATION_IN_S } from './defaults.js';

export enum InterruptionEventType {
  INTERRUPTION = 'interruption',
  OVERLAP_SPEECH_ENDED = 'overlap_speech_ended',
}
export interface InterruptionEvent {
  type: InterruptionEventType;
  timestamp: number;
  isInterruption: boolean;
  totalDurationInS: number;
  predictionDurationInS: number;
  detectionDelayInS: number;
  overlapSpeechStartedAt?: number;
  speechInput?: Int16Array;
  probabilities?: number[];
  probability: number;
}

export class InterruptionDetectionError extends Error {
  readonly type = 'InterruptionDetectionError';

  readonly timestamp: number;
  readonly label: string;
  readonly recoverable: boolean;

  constructor(message: string, timestamp: number, label: string, recoverable: boolean) {
    super(message);
    this.name = 'InterruptionDetectionError';
    this.timestamp = timestamp;
    this.label = label;
    this.recoverable = recoverable;
  }

  toString(): string {
    return `${this.name}: ${this.message} (label=${this.label}, timestamp=${this.timestamp}, recoverable=${this.recoverable})`;
  }
}

function estimateProbability(
  probabilities: number[],
  windowSizeInS: number = MIN_INTERRUPTION_DURATION_IN_S,
): number {
  const minWindow = Math.ceil(windowSizeInS / FRAME_DURATION_IN_S);
  if (probabilities.length < minWindow) {
    return 0;
  }

  return slidingWindowMinMax(probabilities, minWindow);
}

/**
 * Typed cache entry for interruption inference results.
 */
export class InterruptionCacheEntry {
  readonly createdAt: number;
  readonly totalDurationInS: number;
  readonly predictionDurationInS: number;
  readonly detectionDelayInS: number;
  readonly speechInput?: Int16Array;
  readonly probabilities?: number[];
  readonly isInterruption?: boolean;
  readonly probability: number;

  constructor(params: {
    createdAt: number;
    speechInput?: Int16Array;
    totalDurationInS?: number;
    predictionDurationInS?: number;
    detectionDelayInS?: number;
    probabilities?: number[];
    isInterruption?: boolean;
  }) {
    this.createdAt = params.createdAt;
    this.totalDurationInS = params.totalDurationInS ?? 0;
    this.predictionDurationInS = params.predictionDurationInS ?? 0;
    this.detectionDelayInS = params.detectionDelayInS ?? 0;
    this.speechInput = params.speechInput;
    this.probabilities = params.probabilities;
    this.isInterruption = params.isInterruption;
    this.probability = this.probabilities ? estimateProbability(this.probabilities) : 0;
  }

  static default(): InterruptionCacheEntry {
    return new InterruptionCacheEntry({ createdAt: 0 });
  }
}
