// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Span } from '@opentelemetry/api';

export interface OverlappingSpeechEvent {
  type: 'overlapping_speech';
  detectedAt: number;
  isInterruption: boolean;
  /**
   * True when the overlap ended because the agent finished speaking rather than the user.
   * The user may still be talking, so `isInterruption` (always false here) is inconclusive
   * and must not be treated as a confirmed backchannel verdict.
   */
  agentEnded?: boolean;
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
  threshold?: number;
  minFrames: number;
  maxAudioDurationInS: number;
  audioPrefixDurationInS: number;
  detectionIntervalInS: number;
  inferenceTimeout: number;
  minInterruptionDurationInS: number;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
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
  /** Whether the overlap ended because agent speech ended, not because user speech ended. */
  agentEnded?: boolean;
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
