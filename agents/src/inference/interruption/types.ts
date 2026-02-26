// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Span } from '@opentelemetry/api';

// Ref: python inference/interruption.py lines 125-138
export interface OverlappingSpeechEvent {
  type: 'user_overlapping_speech';
  timestamp: number;
  isInterruption: boolean;
  totalDurationInS: number;
  predictionDurationInS: number;
  detectionDelayInS: number;
  overlapStartedAt?: number;
  speechInput?: Int16Array;
  probabilities?: number[];
  probability: number;
  numRequests: number;
}

/**
 * Configuration options for interruption detection.
 */
export interface InterruptionOptions {
  sampleRate: number;
  threshold: number;
  minFrames: number;
  maxAudioDurationInS: number;
  audioPrefixDurationInS: number;
  detectionIntervalInS: number;
  inferenceTimeout: number;
  minInterruptionDurationInS: number;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  useProxy: boolean;
}

/**
 * API connection options for transport layers.
 */
export interface ApiConnectOptions {
  maxRetries: number;
  retryInterval: number;
  timeout: number;
}

// Sentinel types for stream control signals

export interface AgentSpeechStarted {
  type: 'agent-speech-started';
}

export interface AgentSpeechEnded {
  type: 'agent-speech-ended';
}

export interface OverlapSpeechStarted {
  type: 'overlap-speech-started';
  /** Duration of the speech segment in milliseconds (matches VADEvent.speechDuration units). */
  speechDuration: number;
  /** Absolute timestamp (ms) when overlap speech started, computed at call-site. */
  startedAt: number;
  userSpeakingSpan?: Span;
}

export interface OverlapSpeechEnded {
  type: 'overlap-speech-ended';
  /** Absolute timestamp (ms) when overlap speech ended, used as the non-interruption event timestamp. */
  endedAt: number;
}

export interface Flush {
  type: 'flush';
}

/**
 * Union type for all stream control signals.
 */
export type InterruptionSentinel =
  | AgentSpeechStarted
  | AgentSpeechEnded
  | OverlapSpeechStarted
  | OverlapSpeechEnded
  | Flush;
