// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type Throws, ThrowsPromise } from '@livekit/throws-transformer/throws';
import { TransformStream } from 'stream/web';
import WebSocket from 'ws';
import { z } from 'zod';
import { APIConnectionError, APIStatusError, APITimeoutError } from '../../_exceptions.js';
import { log } from '../../log.js';
import { buildMetadataHeaders, createAccessToken } from '../utils.js';
import { THRESHOLD } from './defaults.js';
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
  /**
   * Only set when the user explicitly overrides the threshold; omitted otherwise so the server
   * applies its fetched default.
   */
  threshold?: number;
  minFrames: number;
  timeout: number;
  connectTimeout: number;
  maxRetries?: number;
}

export interface WsTransportState {
  overlapSpeechStarted: boolean;
  overlapSpeechStartedAt: number | undefined;
  cache: BoundedCache<number, InterruptionCacheEntry>;
}

export const wsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(MSG_SESSION_CREATED),
    // The server-recommended interruption threshold. Used as the effective threshold when the
    // user has not explicitly overridden it.
    default_threshold: z.number().nullish(),
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
 * Resolve the effective interruption threshold for observability only — the server makes the
 * actual decision. Precedence: user override, then server default, then THRESHOLD backup.
 */
export function resolveEffectiveThreshold(
  threshold: number | undefined,
  defaultThreshold: number | null | undefined,
): number {
  if (threshold !== undefined) {
    return threshold;
  }
  if (defaultThreshold != null) {
    return defaultThreshold;
  }
  return THRESHOLD;
}

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
    headers: { ...buildMetadataHeaders(), Authorization: `Bearer ${token}` },
  });

  await new ThrowsPromise<void, APIStatusError | APITimeoutError | APIConnectionError>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.terminate();
        reject(
          new APITimeoutError({
            message: 'WebSocket connection timeout',
            options: { retryable: false },
          }),
        );
      }, options.connectTimeout);
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
  transport: TransformStream<Int16Array | OverlappingSpeechEvent, OverlappingSpeechEvent>;
  reconnect: () => Promise<void>;
  /**
   * Close the underlying WebSocket directly. The transport's `flush()` only runs on graceful
   * stream completion, so error/cancel teardown paths must call this to avoid leaking the socket.
   */
  close: () => void;
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
  let outputController: TransformStreamDefaultController<OverlappingSpeechEvent> | null = null;

  function setupMessageHandler(socket: WebSocket): void {
    socket.on('message', (data: WebSocket.Data) => {
      let message: WsMessage;
      try {
        message = wsMessageSchema.parse(JSON.parse(data.toString()));
      } catch (err) {
        logger.warn(
          { data: data.toString(), err: err instanceof Error ? err.message : String(err) },
          'Failed to parse WebSocket message',
        );
        return;
      }
      // Keep handler errors distinct from parse errors — a thrown handler must
      // not be mislabeled as a malformed payload (and its real cause dropped).
      try {
        handleMessage(message);
      } catch (err) {
        logger.warn(
          { type: message.type, err: err instanceof Error ? err.message : String(err) },
          'Failed to handle WebSocket message',
        );
      }
    });

    socket.on('error', (err: Error) => {
      outputController?.error(
        new APIConnectionError({ message: `WebSocket error: ${err.message}` }),
      );
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

    const settings: Record<string, unknown> = {
      sample_rate: options.sampleRate,
      num_channels: 1,
      min_frames: options.minFrames,
      encoding: 's16le',
    };
    // Only send the threshold when the user explicitly overrode it; otherwise let the server
    // apply its fetched default.
    if (options.threshold !== undefined) {
      settings.threshold = options.threshold;
    }
    const sessionCreateMsg = JSON.stringify({
      type: MSG_SESSION_CREATE,
      settings,
    });
    ws.send(sessionCreateMsg);
  }

  function handleMessage(message: WsMessage): void {
    const state = getState();

    switch (message.type) {
      case MSG_SESSION_CREATED: {
        // Observability only — the server makes the actual decision; when we omit the threshold
        // from session.create it applies its fetched default.
        logger.debug(
          {
            defaultThreshold: message.default_threshold,
            effectiveThreshold: resolveEffectiveThreshold(
              options.threshold,
              message.default_threshold,
            ),
            userOverride: options.threshold !== undefined,
          },
          'adaptive interruption session created',
        );
        break;
      }

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

          // `desiredSize === null` means the readable side is errored or
          // closed (e.g. a prior inference timeout, or session teardown). A
          // late prediction can still arrive on the socket; drop it quietly
          // rather than throwing on `enqueue` into a dead stream.
          if (outputController !== null && outputController.desiredSize !== null) {
            outputController.enqueue(event);
          } else {
            logger.debug('interruption output stream closed; dropping late bargein event');
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
        outputController?.error(
          new APIStatusError({
            message: `LiveKit Adaptive Interruption error: ${message.message}`,
            options: { statusCode: message.code ?? -1 },
          }),
        );
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

  const transport = new TransformStream<
    Int16Array | OverlappingSpeechEvent,
    OverlappingSpeechEvent
  >(
    {
      async start(controller) {
        outputController = controller;
        await ensureConnection().catch((e) => {
          controller.error(e);
        });
      },

      transform(chunk, controller) {
        if (!(chunk instanceof Int16Array)) {
          controller.enqueue(chunk);
          return;
        }

        // Only forwards buffered audio while overlap speech is actively on.
        const state = getState();
        if (!state.overlapSpeechStartedAt || !state.overlapSpeechStarted) return;

        if (options.timeout > 0) {
          const now = performance.now();
          for (const [, entry] of state.cache.entries()) {
            if (entry.totalDurationInS !== 0) continue;
            if (now - entry.createdAt > options.timeout) {
              controller.error(
                new APIStatusError({
                  message: `interruption inference timed out after ${((now - entry.createdAt) / 1000).toFixed(1)}s (ws)`,
                  options: { statusCode: 408, retryable: false },
                }),
              );
              return;
            }
            break;
          }
        }

        try {
          sendAudioData(chunk);
        } catch (err) {
          controller.error(err);
        }
      },

      flush() {
        close();
      },
    },
    { highWaterMark: 2 },
    { highWaterMark: 2 },
  );

  return { transport, reconnect, close };
}
