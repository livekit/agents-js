import { Readable, Writable } from 'node:stream';
import { TransformStream } from 'stream/web';
import WebSocket, { createWebSocketStream } from 'ws';
import { log } from '../../log.js';
import { createAccessToken } from '../utils.js';
import { InterruptionCacheEntry } from './InterruptionCacheEntry.js';
import { intervalForRetry } from './defaults.js';
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

interface WsMessage {
  type: string;
  created_at?: number;
  probabilities?: number[];
  prediction_duration?: number;
  is_bargein?: boolean;
  error?: string;
}

export function webSocketToStream(ws: WebSocket) {
  const duplex = createWebSocketStream(ws);
  duplex.on('error', (err) => log().error({ err }, 'WebSocket stream error'));

  // End the write side when the read side ends
  duplex.on('end', () => duplex.end());

  const writable = Writable.toWeb(duplex) as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(duplex) as ReadableStream<Uint8Array>;

  return { readable, writable };
}

/**
 * Creates a WebSocket connection and returns web-standard streams.
 */
async function connectWebSocket(options: WsTransportOptions): Promise<{
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  ws: WebSocket;
}> {
  const baseUrl = options.baseUrl.replace(/^http/, 'ws');
  const url = `${baseUrl}/bargein`;
  const token = await createAccessToken(options.apiKey, options.apiSecret);

  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const { readable, writable } = webSocketToStream(ws);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connection timeout'));
    }, options.timeout);
    ws.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timeout);
      ws.terminate();
      reject(err);
    });
  });

  return { readable, writable, ws };
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
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let readerTask: Promise<void> | null = null;
  let outputController: TransformStreamDefaultController<InterruptionEvent> | null = null;

  async function ensureConnection(): Promise<void> {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const maxRetries = options.maxRetries ?? 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const conn = await connectWebSocket(options);
        ws = conn.ws;
        writer = conn.writable.getWriter();

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
        await writer.write(new TextEncoder().encode(sessionCreateMsg));

        // Start reading responses
        readerTask = processResponses(conn.readable);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delay = intervalForRetry(attempt);
          logger.warn(
            { attempt, delay, err: lastError.message },
            'WebSocket connection failed, retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('Failed to connect to WebSocket after retries');
  }

  async function processResponses(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete JSON messages (newline-delimited or single messages)
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const message: WsMessage = JSON.parse(line);
              handleMessage(message);
            } catch {
              logger.warn({ line }, 'Failed to parse WebSocket message');
            }
          }
        }

        // Also try parsing buffer as complete message (for non-newline-delimited)
        if (buffer.trim()) {
          try {
            const message: WsMessage = JSON.parse(buffer);
            handleMessage(message);
            buffer = '';
          } catch {
            // Incomplete message, keep buffering
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  function handleMessage(message: WsMessage): void {
    const state = getState();

    switch (message.type) {
      case MSG_SESSION_CREATED:
        logger.debug('WebSocket session created');
        break;

      case MSG_INTERRUPTION_DETECTED: {
        const createdAt = message.created_at ?? 0;
        if (state.overlapSpeechStarted && state.overlapSpeechStartedAt !== undefined) {
          const existing = state.cache.get(createdAt);
          const entry = new InterruptionCacheEntry({
            createdAt,
            speechInput: existing?.speechInput,
            totalDurationInS: (performance.now() - createdAt) / 1000,
            probabilities: message.probabilities,
            isInterruption: true,
            predictionDurationInS: message.prediction_duration ?? 0,
            detectionDelayInS: (Date.now() - state.overlapSpeechStartedAt) / 1000,
          });
          state.cache.set(createdAt, entry);

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
            overlapSpeechStartedAt: state.overlapSpeechStartedAt,
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
        const createdAt = message.created_at ?? 0;
        if (state.overlapSpeechStartedAt !== undefined) {
          const existing = state.cache.get(createdAt);
          const entry = new InterruptionCacheEntry({
            createdAt,
            speechInput: existing?.speechInput,
            totalDurationInS: (performance.now() - createdAt) / 1000,
            predictionDurationInS: message.prediction_duration ?? 0,
            probabilities: message.probabilities,
            isInterruption: message.is_bargein ?? false,
            detectionDelayInS: (Date.now() - state.overlapSpeechStartedAt) / 1000,
          });
          state.cache.set(createdAt, entry);

          logger.trace(
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
        logger.error({ error: message.error }, 'WebSocket error message received');
        outputController?.error(new Error(`LiveKit Interruption error: ${message.error}`));
        break;

      default:
        logger.warn({ type: message.type }, 'Received unexpected WebSocket message type');
    }
  }

  async function sendAudioData(audioSlice: Int16Array): Promise<void> {
    await ensureConnection();
    if (!writer) throw new Error('WebSocket not connected');

    const state = getState();
    const createdAt = performance.now();

    // Store the audio data in cache
    state.cache.set(createdAt, new InterruptionCacheEntry({ createdAt, speechInput: audioSlice }));

    // Create header: 8-byte little-endian uint64 timestamp (milliseconds as integer)
    const header = new ArrayBuffer(8);
    const view = new DataView(header);
    const createdAtInt = Math.floor(createdAt);
    view.setUint32(0, createdAtInt >>> 0, true);
    view.setUint32(4, Math.floor(createdAtInt / 0x100000000) >>> 0, true);

    // Combine header and audio data
    const audioBytes = new Uint8Array(
      audioSlice.buffer,
      audioSlice.byteOffset,
      audioSlice.byteLength,
    );
    const combined = new Uint8Array(8 + audioBytes.length);
    combined.set(new Uint8Array(header), 0);
    combined.set(audioBytes, 8);

    await writer.write(combined);
  }

  async function close(): Promise<void> {
    if (writer && ws?.readyState === WebSocket.OPEN) {
      const closeMsg = JSON.stringify({ type: MSG_SESSION_CLOSE });
      await writer.write(new TextEncoder().encode(closeMsg));
      writer.releaseLock();
      writer = null;
    }
    ws?.close(1000);
    ws = null;
    await readerTask;
    readerTask = null;
  }

  /**
   * Reconnect the WebSocket with updated options.
   * This is called when options are updated via updateOptions().
   */
  async function reconnect(): Promise<void> {
    await close();
    // Connection will be re-established on next sendAudioData call
  }

  const transport = new TransformStream<Int16Array | InterruptionEvent, InterruptionEvent>(
    {
      start(controller) {
        outputController = controller;
      },

      async transform(chunk, controller) {
        // Pass through InterruptionEvents unchanged
        if (!(chunk instanceof Int16Array)) {
          controller.enqueue(chunk);
          return;
        }

        const state = getState();
        if (!state.overlapSpeechStartedAt) return;

        try {
          await sendAudioData(chunk);
        } catch (err) {
          logger.error({ err }, 'Failed to send audio data over WebSocket');
        }
      },

      async flush() {
        await close();
      },
    },
    { highWaterMark: 2 },
    { highWaterMark: 2 },
  );

  return { transport, reconnect };
}
