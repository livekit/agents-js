import type { InterruptionOptions } from './AdaptiveInterruptionDetector.js';
import type { ApiConnectOptions } from './InterruptionStream.js';

export const MIN_INTERRUPTION_DURATION = 0.025 * 2; // 25ms per frame, 2 consecutive frames
export const THRESHOLD = 0.65;
export const MAX_AUDIO_DURATION = 3.0;
export const AUDIO_PREFIX_DURATION = 0.5;
export const DETECTION_INTERVAL = 0.1;
export const REMOTE_INFERENCE_TIMEOUT = 1.0;
export const SAMPLE_RATE = 16000;
export const FRAMES_PER_SECOND = 40;
export const DEFAULT_BASE_URL = 'http://localhost:8080';

export const apiConnectDefaults: ApiConnectOptions = {
  maxRetries: 3,
  retryInterval: 2_000,
  timeout: 10_000,
} as const;

export const interruptionOptionDefaults: InterruptionOptions = {
  sampleRate: SAMPLE_RATE,
  threshold: THRESHOLD,
  minFrames: Math.ceil(MIN_INTERRUPTION_DURATION * FRAMES_PER_SECOND),
  maxAudioDuration: MAX_AUDIO_DURATION,
  audioPrefixDuration: AUDIO_PREFIX_DURATION,
  detectionInterval: DETECTION_INTERVAL,
  inferenceTimeout: 10_000,
  baseUrl: DEFAULT_BASE_URL,
  apiKey: process.env.LIVEKIT_API_KEY || '',
  apiSecret: process.env.LIVEKIT_API_SECRET || '',
  useProxy: false,
  minInterruptionDuration: MIN_INTERRUPTION_DURATION,
} as const;
