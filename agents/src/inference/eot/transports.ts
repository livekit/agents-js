// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Audio EOT transports: cloud (WebSocket) + local (@livekit/local-inference).
 *
 * Port of Python `livekit.agents.inference.eot.transports`.
 */
import { type Duration, Timestamp } from '@bufbuild/protobuf';
import { AgentInference } from '@livekit/protocol';
import type { AudioFrame } from '@livekit/rtc-node';
import { APIConnectionError, APIError, APIStatusError } from '../../_exceptions.js';
import type { InferenceExecutor } from '../../ipc/inference_executor.js';
import { log } from '../../log.js';
import { type APIConnectOptions, intervalForRetry } from '../../types.js';
import { Task, delay } from '../../utils.js';
import {
  type AudioTurnDetectionTransport,
  type AudioTurnDetectorStream,
  DEFAULT_SAMPLE_RATE,
  type FlushSentinel,
  type TurnDetectorOptions,
} from '../../voice/turn_config/audio_turn_detector.js';
import { buildMetadataHeaders, connectWs, createAccessToken } from '../utils.js';
import type { AudioTurnDetector } from './detector.js';
import { EOT_INFERENCE_METHOD } from './runner.js';

const AudioEncoding = AgentInference.AudioEncoding;
const ClientMessageCtor = AgentInference.ClientMessage;
const ServerMessageCtor = AgentInference.ServerMessage;
const InferenceStart = AgentInference.InferenceStart;
const InferenceStop = AgentInference.InferenceStop;
const InputAudio = AgentInference.InputAudio;
const SessionClose = AgentInference.SessionClose;
const SessionCreate = AgentInference.SessionCreate;
const SessionFlush = AgentInference.SessionFlush;
const SessionSettings = AgentInference.SessionSettings;
type ClientMsg = InstanceType<typeof AgentInference.ClientMessage>;
type ServerMsg = InstanceType<typeof AgentInference.ServerMessage>;

export interface CloudTransportOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  connOptions: APIConnectOptions;
}

/**
 * Minimal WebSocket shape both the real `ws` socket and test fakes satisfy.
 * The cloud transport only needs send/close/readyState + the three events.
 */
export interface CloudWebSocket {
  send(data: Uint8Array): void;
  close(): void;
  readonly readyState: number;
  on(event: 'message', cb: (data: Buffer | ArrayBuffer | Buffer[]) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

const WS_OPEN = 1;

function nowTimestamp(): Timestamp {
  const now = Date.now();
  return new Timestamp({
    seconds: BigInt(Math.floor(now / 1000)),
    nanos: (now % 1000) * 1_000_000,
  });
}

function timestampToMs(ts?: Timestamp): number {
  if (ts === undefined) return 0;
  return Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1_000_000);
}

function durationToMs(d?: Duration): number {
  if (d === undefined) return 0;
  return Number(d.seconds) * 1000 + Math.floor(d.nanos / 1_000_000);
}

// Native model operates on up to 1.2 s of 16 kHz s16le PCM per predict.
const CLIENT_BUFFER_SECONDS = 1.2;
const CLIENT_BUFFER_SAMPLES = Math.floor(CLIENT_BUFFER_SECONDS * DEFAULT_SAMPLE_RATE);

/**
 * Append-only ring buffer of 16-bit PCM samples used by the local transport
 * to keep the last ~1.2 s of audio available for per-window prediction.
 */
class PcmRingBuffer {
  private buf: Int16Array;
  private writeIdx = 0;
  private filled = 0;

  constructor(public readonly capacity: number) {
    this.buf = new Int16Array(capacity);
  }

  pushFrame(frame: AudioFrame): void {
    const src = frame.data; // Int16Array
    for (let i = 0; i < src.length; i++) {
      this.buf[this.writeIdx] = src[i]!;
      this.writeIdx = (this.writeIdx + 1) % this.capacity;
    }
    this.filled = Math.min(this.filled + src.length, this.capacity);
  }

  /** Returns a contiguous Int16Array snapshot of the last `filled` samples. */
  read(): Int16Array {
    const out = new Int16Array(this.filled);
    const start = (this.writeIdx - this.filled + this.capacity) % this.capacity;
    if (start + this.filled <= this.capacity) {
      out.set(this.buf.subarray(start, start + this.filled));
    } else {
      const tail = this.capacity - start;
      out.set(this.buf.subarray(start, this.capacity), 0);
      out.set(this.buf.subarray(0, this.filled - tail), tail);
    }
    return out;
  }

  /** Drop the oldest `n` samples. */
  shift(n: number): void {
    this.filled = Math.max(0, this.filled - n);
  }

  get length(): number {
    return this.filled;
  }
}

/**
 * Transport for the local `eot-audio-mini` model.
 *
 * The native model runs in the shared `InferenceProcExecutor` (one load per
 * host, ~138 MB) rather than in every job worker. Audio is buffered locally
 * in the job process (no per-frame IPC); on each inference window the last
 * ~1.2 s is snapshotted, base64-encoded, and sent over IPC to the runner
 * (`inference/eot/runner.ts`) via `executor.doInference(...)`.
 *
 * When no executor is available (binding couldn't load on this platform),
 * predictions resolve to a positive default (1.0) so the session still
 * commits turns after `minDelay` — same as the existing local-failure path.
 */
export class LocalTransport implements AudioTurnDetectionTransport {
  protected _opts: TurnDetectorOptions;
  protected _executor: InferenceExecutor | undefined;
  protected _buf: PcmRingBuffer;
  protected _streamRef: WeakRef<AudioTurnDetectorStream> | undefined;
  protected _tasks = new Set<Promise<void>>();
  protected _warnedNoExecutor = false;
  protected _logger = log();

  constructor(opts: { opts: TurnDetectorOptions; executor: InferenceExecutor | undefined }) {
    this._opts = opts.opts;
    this._executor = opts.executor;
    this._buf = new PcmRingBuffer(CLIENT_BUFFER_SAMPLES);
  }

  bind(stream: AudioTurnDetectorStream): void {
    this._streamRef = new WeakRef(stream);
  }

  transportReady(): boolean {
    return true;
  }

  startInference(requestId: string): void {
    const snapshot = this._buf.read();
    const task = this._predict(requestId, snapshot);
    this._tasks.add(task);
    void task.finally(() => this._tasks.delete(task));
  }

  protected async _predict(requestId: string, pcmSnapshot: Int16Array): Promise<void> {
    const stream = this._streamRef?.deref();
    if (stream === undefined) return;

    if (this._executor === undefined) {
      if (!this._warnedNoExecutor) {
        this._warnedNoExecutor = true;
        this._logger.warn(
          'local audio EOT unavailable (no inference executor / native binding); ' +
            'defaulting predictions to 1.0 so turns still commit after minDelay',
        );
      }
      stream._handlePrediction(requestId, 1.0);
      return;
    }

    // base64-encode the s16le PCM so it survives the default JSON IPC
    // serialization compactly (a raw Int16Array would balloon to an
    // array-of-numbers). Only the snapshot crosses the boundary.
    const pcm = Buffer.from(
      pcmSnapshot.buffer,
      pcmSnapshot.byteOffset,
      pcmSnapshot.byteLength,
    ).toString('base64');

    let prob = 0.0;
    let inferenceDurationMs = 0;
    try {
      const out = (await this._executor.doInference(EOT_INFERENCE_METHOD, {
        pcm,
      })) as { probability: number; inferenceDurationMs: number };
      prob = out.probability;
      inferenceDurationMs = out.inferenceDurationMs;
    } catch (err) {
      this._logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'local audio EOT inference (executor) failed',
      );
    }
    const freshStream = this._streamRef?.deref();
    if (freshStream === undefined) return;
    freshStream._handlePrediction(requestId, prob, { inferenceDuration: inferenceDurationMs });
  }

  async pushFrame(frame: AudioFrame): Promise<void> {
    this._buf.pushFrame(frame);
  }

  async flush(sentinel: FlushSentinel): Promise<void> {
    const keepSamples = Math.floor((sentinel.keepTailMs * DEFAULT_SAMPLE_RATE) / 1000);
    if (this._buf.length > keepSamples) {
      this._buf.shift(this._buf.length - keepSamples);
    }
  }

  stopInference(_reason?: string): void {
    // In-flight predictions run to completion; `_predict` drops stale results.
    return;
  }

  detach(): void {
    this._tasks.clear();
  }

  async run(): Promise<void> {
    const stream = this._streamRef?.deref();
    if (stream === undefined) return;
    await stream._drainAudioChannel();
  }
}

/**
 * WebSocket transport for `eot-audio`.
 *
 * Maintains one inference session against the LiveKit Agent Gateway:
 * connect → `SessionCreate` → three concurrent tasks (drain audio, send,
 * receive) → protobuf encode/decode → `stream._handlePrediction(...)` +
 * `EOTInferenceMetrics` on the detector. Mirrors Python `_CloudTransport`.
 *
 * All outbound messages flow through a single FIFO send queue so control
 * hooks fired synchronously between two awaited audio frames (e.g.
 * `inferenceStart` then `inputAudio`) reach the wire in call order.
 */
export class CloudTransport implements AudioTurnDetectionTransport {
  protected _detectorRef: WeakRef<AudioTurnDetector>;
  protected _opts: TurnDetectorOptions;
  protected _cloudOpts: CloudTransportOptions;
  protected _connOptions: APIConnectOptions;
  protected _streamRef: WeakRef<AudioTurnDetectorStream> | undefined;
  protected _ws: CloudWebSocket | undefined;
  protected _numRetries = 0;
  protected _connectCalls = 0;
  protected _sendQueue: ClientMsg[] = [];
  protected _sendNotify: (() => void) | undefined;
  protected _sendClosed = false;
  protected _logger = log();
  /** Optional connect override for tests; defaults to a real WS handshake. */
  private _connectImpl: (() => Promise<CloudWebSocket>) | undefined;

  constructor(args: {
    detector: AudioTurnDetector;
    opts: TurnDetectorOptions;
    cloudOpts: CloudTransportOptions;
    /** @internal test seam — supply a fake WebSocket factory. */
    connect?: (transport: CloudTransport) => Promise<CloudWebSocket>;
  }) {
    this._detectorRef = new WeakRef(args.detector);
    this._opts = args.opts;
    this._cloudOpts = args.cloudOpts;
    this._connOptions = args.cloudOpts.connOptions;
    this._connectImpl = args.connect ? () => args.connect!(this) : undefined;
  }

  /** @internal Test-visible: number of connect attempts. */
  get connectCalls(): number {
    return this._connectCalls;
  }
  /** @internal Test-visible: retry counter (resets to 0 after a connect). */
  get numRetries(): number {
    return this._numRetries;
  }

  bind(stream: AudioTurnDetectorStream): void {
    this._streamRef = new WeakRef(stream);
  }

  transportReady(): boolean {
    return this._ws !== undefined && this._ws.readyState === WS_OPEN;
  }

  startInference(requestId: string): void {
    this._enqueue(
      new ClientMessageCtor({
        message: { case: 'inferenceStart', value: new InferenceStart({ requestId }) },
      }),
    );
  }

  stopInference(_reason?: string): void {
    this._enqueue(
      new ClientMessageCtor({
        message: { case: 'inferenceStop', value: new InferenceStop() },
        createdAt: nowTimestamp(),
      }),
    );
  }

  async pushFrame(frame: AudioFrame): Promise<void> {
    if (frame.data.byteLength === 0) return;
    this._enqueue(
      new ClientMessageCtor({
        message: {
          case: 'inputAudio',
          value: new InputAudio({
            audio: new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
            numSamples: frame.samplesPerChannel,
            createdAt: nowTimestamp(),
          }),
        },
      }),
    );
  }

  async flush(_sentinel: FlushSentinel): Promise<void> {
    this._enqueue(
      new ClientMessageCtor({ message: { case: 'sessionFlush', value: new SessionFlush() } }),
    );
  }

  detach(): void {
    this._sendClosed = true;
    this._sendNotify?.();
    this._ws = undefined;
  }

  private _enqueue(msg: ClientMsg): void {
    if (this._sendClosed) return;
    this._sendQueue.push(msg);
    this._sendNotify?.();
  }

  private async _defaultConnect(): Promise<CloudWebSocket> {
    let baseUrl = this._cloudOpts.baseUrl;
    if (baseUrl.startsWith('http://')) baseUrl = baseUrl.replace('http://', 'ws://');
    else if (baseUrl.startsWith('https://')) baseUrl = baseUrl.replace('https://', 'wss://');
    const token = await createAccessToken(this._cloudOpts.apiKey, this._cloudOpts.apiSecret);
    const headers = { ...buildMetadataHeaders(), Authorization: `Bearer ${token}` };
    const ws = await connectWs(`${baseUrl}/eot`, headers, this._connOptions.timeoutMs);
    return ws as unknown as CloudWebSocket;
  }

  protected _processServerMessage(msg: ServerMsg): void {
    const stream = this._streamRef?.deref();
    if (stream === undefined) return;
    const kind = msg.message.case;
    if (kind === 'eotPrediction') {
      const prediction = msg.message.value;
      const stats = prediction.inferenceStats;
      const requestSentAtMs = timestampToMs(stats?.latestClientCreatedAt);
      const detectionDelayMs = requestSentAtMs > 0 ? Date.now() - requestSentAtMs : 0;
      const inferenceDurationMs = durationToMs(stats?.serverE2eLatency);
      stream._handlePrediction(msg.requestId ?? '', prediction.probability, {
        detectionDelay: detectionDelayMs,
        inferenceDuration: inferenceDurationMs,
      });
      const detector = this._detectorRef.deref();
      if (detector !== undefined) {
        detector.emit('metrics_collected', {
          type: 'eot_inference_metrics',
          timestamp: Date.now(),
          totalDuration: durationToMs(stats?.clientE2eLatency),
          predictionDuration: inferenceDurationMs,
          detectionDelay: detectionDelayMs,
          numRequests: 1,
          metadata: { modelName: detector.model, modelProvider: detector.provider },
        });
      }
    } else if (kind === 'error') {
      const err = msg.message.value;
      throw new APIStatusError({
        message: err.message,
        options: { statusCode: err.code, requestId: msg.requestId },
      });
    } else if (
      kind === 'sessionCreated' ||
      kind === 'sessionClosed' ||
      kind === 'inferenceStarted' ||
      kind === 'inferenceStopped'
    ) {
      const clientCreatedAtMs = timestampToMs(msg.clientCreatedAt);
      const transportLatency = Date.now() - clientCreatedAtMs;
      if (transportLatency > 500 && clientCreatedAtMs > 0) {
        this._logger.warn(
          { transportLatencyMs: transportLatency },
          'turn detection transport latency is too high',
        );
      }
    } else {
      this._logger.warn({ kind }, 'unexpected turn detector message');
    }
  }

  async run(): Promise<void> {
    const maxRetries = this._connOptions.maxRetry;
    while (this._numRetries <= maxRetries) {
      try {
        await this._runOnce();
        return;
      } catch (err) {
        if (!(err instanceof APIError) || maxRetries === 0 || !err.retryable) throw err;
        if (this._numRetries === maxRetries) {
          throw new APIConnectionError({
            message: `failed to connect livekit turn detector after ${this._numRetries} attempts`,
          });
        }
        const retryIntervalMs = intervalForRetry(this._connOptions, this._numRetries);
        this._logger.warn(
          { err: err.message, attempt: this._numRetries, retryIntervalMs },
          'livekit turn detector connection failed; retrying',
        );
        await delay(retryIntervalMs);
        this._numRetries += 1;
      }
    }
  }

  protected async _runOnce(): Promise<void> {
    const stream = this._streamRef?.deref();
    if (stream === undefined) return;

    this._connectCalls += 1;
    const ws = await (this._connectImpl ?? this._defaultConnect.bind(this))();

    // Successful connect — reset transient-failure counter so drops across
    // the session lifetime don't accumulate toward maxRetry.
    this._numRetries = 0;
    this._ws = ws;
    this._sendClosed = false;
    this._sendQueue = [];

    // Send the SessionCreate handshake first, before any queued control msg.
    ws.send(
      new ClientMessageCtor({
        message: {
          case: 'sessionCreate',
          value: new SessionCreate({
            settings: new SessionSettings({
              sampleRate: this._opts.sampleRate,
              encoding: AudioEncoding.PCM_S16LE,
            }),
          }),
        },
        createdAt: nowTimestamp(),
      }).toBinary(),
    );

    let closingWs = false;
    let closed = false;
    let socketErr: Error | undefined;
    const recvBuffer: Uint8Array[] = [];
    let recvNotify: (() => void) | undefined;

    ws.on('message', (data) => {
      const chunk =
        data instanceof Buffer
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : Array.isArray(data)
            ? new Uint8Array(Buffer.concat(data))
            : new Uint8Array(data);
      recvBuffer.push(chunk);
      recvNotify?.();
    });
    ws.on('close', () => {
      closed = true;
      recvNotify?.();
      this._sendNotify?.();
    });
    ws.on('error', (err) => {
      socketErr = err;
      closed = true;
      recvNotify?.();
      this._sendNotify?.();
    });

    const drainAudioTask = Task.from(async () => {
      await stream._drainAudioChannel();
      closingWs = true;
      this._enqueue(
        new ClientMessageCtor({ message: { case: 'sessionClose', value: new SessionClose() } }),
      );
      this._sendClosed = true;
      this._sendNotify?.();
    });

    const senderTask = Task.from(async () => {
      while (!this._sendClosed || this._sendQueue.length > 0) {
        if (this._sendQueue.length === 0) {
          await new Promise<void>((resolve) => {
            this._sendNotify = resolve;
          });
          this._sendNotify = undefined;
          continue;
        }
        const msg = this._sendQueue.shift()!;
        if (msg.createdAt === undefined) msg.createdAt = nowTimestamp();
        if (ws.readyState !== WS_OPEN) return;
        try {
          ws.send(msg.toBinary());
        } catch {
          return;
        }
      }
    });

    const recvTask = Task.from(async () => {
      while (!closed || recvBuffer.length > 0) {
        if (recvBuffer.length === 0) {
          await new Promise<void>((resolve) => {
            recvNotify = resolve;
          });
          recvNotify = undefined;
          continue;
        }
        const chunk = recvBuffer.shift()!;
        this._processServerMessage(ServerMessageCtor.fromBinary(chunk));
      }
      if (socketErr !== undefined && !closingWs) {
        throw new APIConnectionError({
          message: `turn detector connection error: ${socketErr.message}`,
        });
      }
      if (!closingWs) {
        throw new APIStatusError({
          message: 'turn detector connection closed unexpectedly',
          options: { statusCode: -1 },
        });
      }
    });

    try {
      await Promise.all([drainAudioTask.result, senderTask.result, recvTask.result]);
    } finally {
      drainAudioTask.cancel();
      senderTask.cancel();
      recvTask.cancel();
      this._sendClosed = true;
      this._sendNotify?.();
      this._ws = undefined;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }
}

// Re-export the transport interface from the FSM module so callers that
// import `AudioTurnDetectionTransport` from this package barrel see the
// same type.
export type { AudioTurnDetectionTransport };
// Expose APIError so detector + fallback code can narrow on it.
export type { APIError };
