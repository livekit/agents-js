import type { InterruptionOptions } from './AdaptiveInterruptionDetector.js';
import type { ApiConnectOptions } from './InterruptionStream.js';

export const MIN_INTERRUPTION_DURATION_IN_S = 0.025 * 2; // 25ms per frame, 2 consecutive frames
export const THRESHOLD = 0.65;
export const MAX_AUDIO_DURATION_IN_S = 3.0;
export const AUDIO_PREFIX_DURATION_IN_S = 0.5;
export const DETECTION_INTERVAL_IN_S = 0.1;
export const REMOTE_INFERENCE_TIMEOUT_IN_S = 1.0;
export const SAMPLE_RATE = 16000;
export const FRAMES_PER_SECOND = 40;
export const FRAME_DURATION_IN_S = 0.025; // 25ms per frame
export const DEFAULT_BASE_URL = 'http://localhost:8080';

export const apiConnectDefaults: ApiConnectOptions = {
  maxRetries: 3,
  retryInterval: 2_000,
  timeout: 10_000,
} as const;

export const interruptionOptionDefaults: InterruptionOptions = {
  sampleRate: SAMPLE_RATE,
  threshold: THRESHOLD,
  minFrames: Math.ceil(MIN_INTERRUPTION_DURATION_IN_S * FRAMES_PER_SECOND),
  maxAudioDurationInS: MAX_AUDIO_DURATION_IN_S,
  audioPrefixDurationInS: AUDIO_PREFIX_DURATION_IN_S,
  detectionIntervalInS: DETECTION_INTERVAL_IN_S,
  inferenceTimeout: 10_000,
  baseUrl: DEFAULT_BASE_URL,
  apiKey: process.env.LIVEKIT_API_KEY || '',
  apiSecret: process.env.LIVEKIT_API_SECRET || '',
  useProxy: false,
  minInterruptionDurationInS: MIN_INTERRUPTION_DURATION_IN_S,
} as const;
