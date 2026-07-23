// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type Throws, ThrowsPromise } from '@livekit/throws-transformer/throws';
import { TransformStream } from 'stream/web';
import WebSocket from 'ws';
import { z } from 'zod';
import { APIConnectionError, APIStatusError, APITimeoutError } from '../../_exceptions.js';
import { log } from '../../log.js';
import { Event } from '../../utils.js';
import { buildMetadataHeaders, createAccessToken } from '../utils.js';
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
 * actual decision. Precedence: user override, then server default; null when neither is known.
 */
export function resolveEffectiveThreshold(
  threshold: number | undefined,
  defaultThreshold: number | null | undefined,
): number | null {
  if (threshold !== undefined) {
    return threshold;
  }
  if (defaultThreshold != null) {
    return defaultThreshold;
  }
  return null;
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

  try {
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
  } finally {
    // Drop the connection-phase once() listeners so a later socket error can't fire the stale
    // once('error') alongside the operational on('error'). Safe to remove all: the message handler
    // is attached after this returns.
    ws.removeAllListeners();
  }

  return ws;
}

export interface WsTransportResult {
  transport: TransformStream<Int16Array | OverlappingSpeechEvent, OverlappingSpeechEvent>;
  reconnect: () => Promise<void>;
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
  let activeWs: WebSocket | null = null;
  let outputController: TransformStreamDefaultController<OverlappingSpeechEvent> | null = null;

  // `reconnecting` is the in-flight reconnect; transform() awaits it so it never sends on a socket
  // being torn down. `closed` lets the background watcher exit its loop.
  const reconnectEvent = new Event();
  let reconnecting: Promise<void> | null = null;
  let closed = false;

  function setupMessageHandler(socket: WebSocket): void {
    socket.on('message', (data: WebSocket.Data) => {
      let message: WsMessage;
      try {
        message = wsMessageSchema.parse(JSON.parse(data.toString()));
      } catch (err) {
        logger.warn(
          {
            'lk.pii.data': data.toString(),
            'lk.pii.error': err instanceof Error ? err.message : String(err),
          },
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
          {
            type: message.type,
            'lk.pii.error': err instanceof Error ? err.message : String(err),
          },
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
      logger.debug({ code, 'lk.pii.reason': reason.toString() }, 'WebSocket closed');
    });
  }

  async function ensureConnection(): Promise<
    Throws<void, APIStatusError | APITimeoutError | APIConnectionError>
  > {
    if (activeWs && activeWs.readyState === WebSocket.OPEN) return;

    activeWs = await connectWebSocket(options);
    setupMessageHandler(activeWs);

    const settings: Record<string, unknown> = {
      sample_rate: options.sampleRate,
      num_channels: 1,
      min_frames: options.minFrames,
      encoding: 's16le',
    };
    if (options.threshold !== undefined) {
      settings.threshold = options.threshold;
    }
    const sessionCreateMsg = JSON.stringify({
      type: MSG_SESSION_CREATE,
      settings,
    });
    activeWs.send(sessionCreateMsg);
  }

  function handleMessage(message: WsMessage): void {
    const state = getState();

    switch (message.type) {
      case MSG_SESSION_CREATED: {
        if (options.threshold === undefined && message.default_threshold == null) {
          outputController?.error(
            new APIStatusError({
              message:
                'adaptive interruption session created without a threshold: no user override and the server did not report a default_threshold',
              options: { statusCode: 500, retryable: false },
            }),
          );
          break;
        }
        // Observability only — the server makes the actual decision.
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
    // Backstop for a genuine unexpected drop: throws a retryable error so the stream fails over. An
    // intentional reconnect is awaited in transform() before we get here, so it won't fire then.
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
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

    activeWs.send(combined);
    onRequestSent?.();
  }

  // Close the current socket without ending the transport (used by both close() and reconnect).
  function closeSocket(): void {
    if (activeWs?.readyState === WebSocket.OPEN) {
      const closeMsg = JSON.stringify({ type: MSG_SESSION_CLOSE });
      try {
        activeWs.send(closeMsg);
      } catch (e: unknown) {
        logger.error(e, 'failed to send close message');
      }
    }
    // The abandoned socket can still emit 'error' during its close handshake; that handler closes
    // over the shared outputController, so a late error would tear down the replacement stream.
    activeWs?.removeAllListeners();
    activeWs?.close(1000); // signal normal websocket closure
    activeWs = null;
  }

  function close(): void {
    closed = true;
    reconnectEvent.set(); // wake the watcher so it exits its loop
    closeSocket();
  }

  /**
   * Request an in-place reconnect to apply updated options (threshold / min frames): it does not
   * error the stream and does not consume a failover retry. The work happens in reconnectWatcher().
   */
  async function reconnect(): Promise<void> {
    if (closed) return;
    reconnectEvent.set();
  }

  // Background loop that reconnects in place when reconnect() fires, so applying new options keeps
  // the stream alive and off the failover retry path.
  async function reconnectWatcher(): Promise<void> {
    while (!closed) {
      await reconnectEvent.wait();
      if (closed) break;
      reconnectEvent.clear();

      // `.catch` keeps `reconnecting` non-rejecting (transform awaits it); a genuine reconnect
      // failure is routed to the stream as an error — a legitimate retry.
      const done = (async () => {
        closeSocket();
        getState().cache.clear(); // abandon the old socket's unanswered in-flight requests
        await ensureConnection();
        // close() may have raced in during the await; its closeSocket() saw activeWs === null and
        // was a no-op, so tear down the socket we just opened — else it leaks with live handlers.
        if (closed) closeSocket();
      })().catch((e: unknown) => {
        outputController?.error(e);
      });
      reconnecting = done;
      try {
        await done;
      } finally {
        if (reconnecting === done) reconnecting = null;
      }
    }
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
        void reconnectWatcher();
      },

      async transform(chunk, controller) {
        if (!(chunk instanceof Int16Array)) {
          controller.enqueue(chunk);
          return;
        }

        // Wait out any in-flight reconnect so we don't send on a socket being torn down. It never
        // rejects — a failed reconnect has already errored the stream via outputController.
        if (reconnecting) await reconnecting;

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
