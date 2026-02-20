// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { TransformStream } from 'stream/web';
import WebSocket from 'ws';
import { z } from 'zod';
import { log } from '../../log.js';
import { createAccessToken } from '../utils.js';
import { intervalForRetry } from './defaults.js';
import { InterruptionCacheEntry } from './interruption_cache_entry.js';
import { type InterruptionEvent, InterruptionEventType } from './types.js';
import type { BoundedCache } from './utils.js';

// WebSocket message types
const MSG_SESSION_CREATE = 'session.create';
const MSG_SESSION_CLOSE = 'session.close';
const MSG_SESSION_CREATED = 'session.created';
const MSG_SESSION_CLOSED = 'session.closed';
const MSG_INTERRUPTION_DETECTED = 'bargein_detected';
const MSG_INFERENCE_DONE = 'inference_done';
const MSG_ERROR = 'error';

export interface WsTransportOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  sampleRate: number;
  threshold: number;
  minFrames: number;
  timeout: number;
  maxRetries?: number;
}

export interface WsTransportState {
  overlapSpeechStarted: boolean;
  overlapSpeechStartedAt: number | undefined;
  cache: BoundedCache<number, InterruptionCacheEntry>;
}

const wsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(MSG_SESSION_CREATED),
  }),
  z.object({
    type: z.literal(MSG_SESSION_CLOSED),
  }),
  z.object({
    type: z.literal(MSG_INTERRUPTION_DETECTED),
    created_at: z.number(),
    probabilities: z.array(z.number()).default([]),
    prediction_duration: z.number().default(0),
  }),
  z.object({
    type: z.literal(MSG_INFERENCE_DONE),
    created_at: z.number(),
    probabilities: z.array(z.number()).default([]),
    prediction_duration: z.number().default(0),
    is_bargein: z.boolean().optional(),
  }),
  z.object({
    type: z.literal(MSG_ERROR),
    message: z.string(),
    code: z.number().optional(),
    session_id: z.string().optional(),
  }),
]);

type WsMessage = z.infer<typeof wsMessageSchema>;

/**
 * Creates a WebSocket connection and waits for it to open.
 */
async function connectWebSocket(options: WsTransportOptions): Promise<WebSocket> {
  const baseUrl = options.baseUrl.replace(/^http/, 'ws');
  const token = await createAccessToken(options.apiKey, options.apiSecret);
  const url = `${baseUrl}/bargein`;

  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connection timeout'));
    }, options.timeout);
    ws.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once('error', (err: Error) => {
      clearTimeout(timeout);
      ws.terminate();
      reject(err);
    });
  });

  return ws;
}

export interface WsTransportResult {
  transport: TransformStream<Int16Array | InterruptionEvent, InterruptionEvent>;
  reconnect: () => Promise<void>;
}

/**
 * Creates a WebSocket transport TransformStream for interruption detection.
 *
 * This transport receives Int16Array audio slices and outputs InterruptionEvents.
 * It maintains a persistent WebSocket connection with automatic retry on failure.
 * Returns both the transport and a reconnect function for option updates.
 */
export function createWsTransport(
  options: WsTransportOptions,
  getState: () => WsTransportState,
  setState: (partial: Partial<WsTransportState>) => void,
  updateUserSpeakingSpan?: (entry: InterruptionCacheEntry) => void,
): WsTransportResult {
  const logger = log();
  let ws: WebSocket | null = null;
  let outputController: TransformStreamDefaultController<InterruptionEvent> | null = null;

  function setupMessageHandler(socket: WebSocket): void {
    socket.on('message', (data: WebSocket.Data) => {
      try {
        const message = wsMessageSchema.parse(JSON.parse(data.toString()));
        handleMessage(message);
      } catch {
        logger.warn({ data: data.toString() }, 'Failed to parse WebSocket message');
      }
    });

    socket.on('error', (err: Error) => {
      logger.error({ err }, 'WebSocket error');
    });

    socket.on('close', (code: number, reason: Buffer) => {
      logger.debug({ code, reason: reason.toString() }, 'WebSocket closed');
    });
  }

  async function ensureConnection(): Promise<void> {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const maxRetries = options.maxRetries ?? 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        ws = await connectWebSocket(options);
        setupMessageHandler(ws);

        // Send session.create message
        const sessionCreateMsg = JSON.stringify({
          type: MSG_SESSION_CREATE,
          settings: {
            sample_rate: options.sampleRate,
            num_channels: 1,
            threshold: options.threshold,
            min_frames: options.minFrames,
            encoding: 's16le',
          },
        });
        ws.send(sessionCreateMsg);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delay = intervalForRetry(attempt);
          logger.debug(
            { attempt, delay, err: lastError.message },
            'WebSocket connection failed, retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('Failed to connect to WebSocket after retries');
  }

  function handleMessage(message: WsMessage): void {
    const state = getState();

    switch (message.type) {
      case MSG_SESSION_CREATED:
        logger.debug('WebSocket session created');
        break;

      case MSG_INTERRUPTION_DETECTED: {
        const createdAt = message.created_at;
        const overlapSpeechStartedAt = state.overlapSpeechStartedAt;
        if (state.overlapSpeechStarted && overlapSpeechStartedAt !== undefined) {
          const existing = state.cache.get(createdAt);

          // prediction_duration in WS payload is seconds.
          // total_duration should be measured from local send-time to avoid unit ambiguity
          // of created_at across runtimes/protocol variants.
          const totalDurationInS =
            existing?.requestStartedAt !== undefined
              ? (performance.now() - existing.requestStartedAt) / 1000
              : (performance.now() - createdAt) / 1000;

          const entry = state.cache.setOrUpdate(
            createdAt,
            () => new InterruptionCacheEntry({ createdAt }),
            {
              speechInput: existing?.speechInput,
              requestStartedAt: existing?.requestStartedAt,
              totalDurationInS,
              probabilities: message.probabilities,
              isInterruption: true,
              predictionDurationInS: message.prediction_duration,
              detectionDelayInS: (Date.now() - overlapSpeechStartedAt) / 1000,
            },
          );

          if (updateUserSpeakingSpan) {
            updateUserSpeakingSpan(entry);
          }

          logger.debug(
            {
              totalDurationInS: entry.totalDurationInS,
              predictionDurationInS: entry.predictionDurationInS,
              detectionDelayInS: entry.detectionDelayInS,
              probability: entry.probability,
            },
            'interruption detected',
          );

          const event: InterruptionEvent = {
            type: InterruptionEventType.INTERRUPTION,
            timestamp: Date.now(),
            isInterruption: true,
            totalDurationInS: entry.totalDurationInS,
            predictionDurationInS: entry.predictionDurationInS,
            overlapSpeechStartedAt,
            speechInput: entry.speechInput,
            probabilities: entry.probabilities,
            detectionDelayInS: entry.detectionDelayInS,
            probability: entry.probability,
          };

          outputController?.enqueue(event);
          setState({ overlapSpeechStarted: false });
        }
        break;
      }

      case MSG_INFERENCE_DONE: {
        const createdAt = message.created_at;
        const overlapSpeechStartedAt = state.overlapSpeechStartedAt;
        if (state.overlapSpeechStarted && overlapSpeechStartedAt !== undefined) {
          const existing = state.cache.get(createdAt);
          const totalDurationInS =
            existing?.requestStartedAt !== undefined
              ? (performance.now() - existing.requestStartedAt) / 1000
              : (performance.now() - createdAt) / 1000;
          const entry = state.cache.setOrUpdate(
            createdAt,
            () => new InterruptionCacheEntry({ createdAt }),
            {
              speechInput: existing?.speechInput,
              requestStartedAt: existing?.requestStartedAt,
              totalDurationInS,
              predictionDurationInS: message.prediction_duration,
              probabilities: message.probabilities,
              isInterruption: message.is_bargein ?? false,
              detectionDelayInS: (Date.now() - overlapSpeechStartedAt) / 1000,
            },
          );

          logger.debug(
            {
              totalDurationInS: entry.totalDurationInS,
              predictionDurationInS: entry.predictionDurationInS,
            },
            'interruption inference done',
          );
        }
        break;
      }

      case MSG_SESSION_CLOSED:
        logger.debug('WebSocket session closed');
        break;

      case MSG_ERROR:
        outputController?.error(
          new Error(
            `LiveKit Adaptive Interruption error${
              message.code !== undefined ? ` (${message.code})` : ''
            }: ${message.message}`,
          ),
        );
        break;
    }
  }

  function sendAudioData(audioSlice: Int16Array): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const state = getState();
    // Use truncated timestamp consistently for both cache key and header
    // This ensures the server's response created_at matches our cache key
    const createdAt = Math.floor(performance.now());

    // Store the audio data in cache with truncated timestamp
    state.cache.set(
      createdAt,
      new InterruptionCacheEntry({
        createdAt,
        requestStartedAt: performance.now(),
        speechInput: audioSlice,
      }),
    );

    // Create header: 8-byte little-endian uint64 timestamp (milliseconds as integer)
    const header = new ArrayBuffer(8);
    const view = new DataView(header);
    view.setUint32(0, createdAt >>> 0, true);
    view.setUint32(4, Math.floor(createdAt / 0x100000000) >>> 0, true);

    // Combine header and audio data
    const audioBytes = new Uint8Array(
      audioSlice.buffer,
      audioSlice.byteOffset,
      audioSlice.byteLength,
    );
    const combined = new Uint8Array(8 + audioBytes.length);
    combined.set(new Uint8Array(header), 0);
    combined.set(audioBytes, 8);

    try {
      ws.send(combined);
    } catch (e: unknown) {
      logger.error(e, `failed to send audio via websocket`);
    }
  }

  function close(): void {
    if (ws?.readyState === WebSocket.OPEN) {
      const closeMsg = JSON.stringify({ type: MSG_SESSION_CLOSE });
      try {
        ws.send(closeMsg);
      } catch (e: unknown) {
        logger.error(e, 'failed to send close message');
      }
    }
    ws?.close(1000); // signal normal websocket closure
    ws = null;
  }

  /**
   * Reconnect the WebSocket with updated options.
   * This is called when options are updated via updateOptions().
   */
  async function reconnect(): Promise<void> {
    close();
  }

  const transport = new TransformStream<Int16Array | InterruptionEvent, InterruptionEvent>(
    {
      async start(controller) {
        outputController = controller;
        await ensureConnection();
      },

      transform(chunk, controller) {
        // Pass through InterruptionEvents unchanged
        if (!(chunk instanceof Int16Array)) {
          controller.enqueue(chunk);
          return;
        }

        // Only forwards buffered audio while overlap speech is actively on.
        const state = getState();
        if (!state.overlapSpeechStartedAt || !state.overlapSpeechStarted) return;

        try {
          sendAudioData(chunk);
        } catch (err) {
          logger.error({ err }, 'Failed to send audio data over WebSocket');
        }
      },

      flush() {
        close();
      },
    },
    { highWaterMark: 2 },
    { highWaterMark: 2 },
  );

  return { transport, reconnect };
}
