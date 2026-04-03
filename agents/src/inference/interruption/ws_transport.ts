// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Throws } from '@livekit/throws-transformer/throws';
import WebSocket from 'ws';
import { z } from 'zod';
import { APIConnectionError, APIStatusError, APITimeoutError } from '../../_exceptions.js';
import { log } from '../../log.js';
import { Chan } from '../../stream/chan.js';
import TypedPromise from '../../typed_promise.js';
import { createAccessToken } from '../utils.js';
import type { TransportFn } from './http_transport.js';
import { InterruptionCacheEntry } from './interruption_cache_entry.js';
import type { OverlappingSpeechEvent } from './types.js';
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
async function connectWebSocket(
  options: WsTransportOptions,
): Promise<Throws<WebSocket, APIStatusError | APITimeoutError | APIConnectionError>> {
  const baseUrl = options.baseUrl.replace(/^http/, 'ws');
  const token = await createAccessToken(options.apiKey, options.apiSecret);
  const url = `${baseUrl}/bargein`;

  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  await new TypedPromise<void, APIStatusError | APITimeoutError | APIConnectionError>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.terminate();
        reject(
          new APITimeoutError({
            message: 'WebSocket connection timeout',
            options: { retryable: false },
          }),
        );
      }, options.timeout);
      ws.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timeout);
        ws.terminate();
        const statusCode = res.statusCode ?? -1;
        reject(
          new APIStatusError({
            message: `WebSocket connection rejected with status ${statusCode}`,
            options: { statusCode, retryable: false },
          }),
        );
      });
      ws.once('error', (err: Error) => {
        clearTimeout(timeout);
        ws.terminate();
        reject(new APIConnectionError({ message: `WebSocket connection error: ${err.message}` }));
      });
    },
  );

  return ws;
}

export interface WsTransportResult {
  transport: TransportFn;
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
  onRequestSent?: () => void,
  getAndResetNumRequests?: () => number,
): WsTransportResult {
  const logger = log();
  let ws: WebSocket | null = null;
  let outputChan: Chan<OverlappingSpeechEvent> | null = null;
  let transportError: unknown = null;

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
      transportError = new APIConnectionError({ message: `WebSocket error: ${err.message}` });
      outputChan?.close();
    });

    socket.on('close', (code: number, reason: Buffer) => {
      logger.debug({ code, reason: reason.toString() }, 'WebSocket closed');
    });
  }

  async function ensureConnection(): Promise<
    Throws<void, APIStatusError | APITimeoutError | APIConnectionError>
  > {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    ws = await connectWebSocket(options);
    setupMessageHandler(ws);

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
              totalDuration: entry.totalDurationInS,
              predictionDuration: entry.predictionDurationInS,
              detectionDelay: entry.detectionDelayInS,
              probability: entry.probability,
            },
            'interruption detected',
          );

          const event: OverlappingSpeechEvent = {
            type: 'overlapping_speech',
            detectedAt: Date.now(),
            isInterruption: true,
            totalDurationInS: entry.totalDurationInS,
            predictionDurationInS: entry.predictionDurationInS,
            overlapStartedAt: overlapSpeechStartedAt,
            speechInput: entry.speechInput,
            probabilities: entry.probabilities,
            detectionDelayInS: entry.detectionDelayInS,
            probability: entry.probability,
            numRequests: getAndResetNumRequests?.() ?? 0,
          };

          try {
            outputChan?.sendNowait(event);
          } catch {
            // Chan closed
          }
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
        transportError = new APIStatusError({
          message: `LiveKit Adaptive Interruption error: ${message.message}`,
          options: { statusCode: message.code ?? -1 },
        });
        outputChan?.close();
        break;
    }
  }

  function sendAudioData(audioSlice: Int16Array): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new APIConnectionError({ message: 'WebSocket not connected' });
    }

    const state = getState();
    const createdAt = Math.floor(performance.now());

    state.cache.set(
      createdAt,
      new InterruptionCacheEntry({
        createdAt,
        requestStartedAt: performance.now(),
        speechInput: audioSlice,
      }),
    );

    const header = new ArrayBuffer(8);
    const view = new DataView(header);
    view.setUint32(0, createdAt >>> 0, true);
    view.setUint32(4, Math.floor(createdAt / 0x100000000) >>> 0, true);

    const audioBytes = new Uint8Array(
      audioSlice.buffer,
      audioSlice.byteOffset,
      audioSlice.byteLength,
    );
    const combined = new Uint8Array(8 + audioBytes.length);
    combined.set(new Uint8Array(header), 0);
    combined.set(audioBytes, 8);

    ws.send(combined);
    onRequestSent?.();
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

  const transport: TransportFn = async function* (source) {
    outputChan = new Chan<OverlappingSpeechEvent>();
    transportError = null;

    await ensureConnection();

    // Pump source in background: consume input, send audio to WS, passthrough events
    const pump = (async () => {
      try {
        for await (const chunk of source) {
          if (!(chunk instanceof Int16Array)) {
            try {
              outputChan!.sendNowait(chunk);
            } catch {
              break;
            }
            continue;
          }

          // Only forwards buffered audio while overlap speech is actively on.
          const state = getState();
          if (!state.overlapSpeechStartedAt || !state.overlapSpeechStarted) continue;

          if (options.timeout > 0) {
            const now = performance.now();
            for (const [, entry] of state.cache.entries()) {
              if (entry.totalDurationInS !== 0) continue;
              if (now - entry.createdAt > options.timeout) {
                transportError = new APIStatusError({
                  message: `interruption inference timed out after ${((now - entry.createdAt) / 1000).toFixed(1)}s (ws)`,
                  options: { statusCode: 408, retryable: false },
                });
                outputChan!.close();
                return;
              }
              break;
            }
          }

          try {
            sendAudioData(chunk);
          } catch (err) {
            transportError = err;
            outputChan!.close();
            return;
          }
        }
      } finally {
        close();
        outputChan!.close();
      }
    })();

    try {
      for await (const event of outputChan) {
        yield event;
      }
      if (transportError) {
        throw transportError;
      }
    } finally {
      await pump;
    }
  };

  return { transport, reconnect };
}
