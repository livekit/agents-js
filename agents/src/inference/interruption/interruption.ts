import { slidingWindowMinMax } from '../utils.js';
import { MIN_INTERRUPTION_DURATION } from './defaults.js';

export enum InterruptionEventType {
  INTERRUPTION = 'interruption',
  OVERLAP_SPEECH_ENDED = 'overlap_speech_ended',
}
export interface InterruptionEvent {
  type: InterruptionEventType;
  timestamp: number;
  isInterruption: boolean;
  totalDuration: number;
  predictionDuration: number;
  detectionDelay: number;
  overlapSpeechStartedAt?: number;
  speechInput?: Int16Array;
  probabilities?: Float32Array;
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
  probabilities: Float32Array,
  windowSize: number = MIN_INTERRUPTION_DURATION,
): number {
  const minWindow = Math.ceil(windowSize / 0.025); // 25ms per frame
  if (probabilities.length < minWindow) {
    return 0;
  }

  return slidingWindowMinMax(probabilities, windowSize);
}

/**
 * Typed cache entry for interruption inference results.
 */
export class InterruptionCacheEntry {
  readonly createdAt: number;
  readonly totalDuration: number;
  readonly predictionDuration: number;
  readonly detectionDelay: number;
  readonly speechInput?: Int16Array;
  readonly probabilities?: Float32Array;
  readonly isInterruption?: boolean;
  readonly probability: number;

  constructor(params: {
    createdAt: number;
    speechInput?: Int16Array;
    totalDuration?: number;
    predictionDuration?: number;
    detectionDelay?: number;
    probabilities?: Float32Array;
    isInterruption?: boolean;
  }) {
    this.createdAt = params.createdAt;
    this.totalDuration = params.totalDuration ?? 0;
    this.predictionDuration = params.predictionDuration ?? 0;
    this.detectionDelay = params.detectionDelay ?? 0;
    this.speechInput = params.speechInput;
    this.probabilities = params.probabilities;
    this.isInterruption = params.isInterruption;
    this.probability = this.probabilities ? estimateProbability(this.probabilities) : 0;
  }

  static default(): InterruptionCacheEntry {
    return new InterruptionCacheEntry({ createdAt: 0 });
  }
}
