// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type APIConnectOptions,
  APIError,
  APITimeoutError,
  AsyncIterableQueue,
  type VAD,
  VADEventType,
  type VADStream,
  asLanguageCode,
  stt,
} from '@livekit/agents';
import { AudioFrame, AudioResampler } from '@livekit/rtc-node';
import type { STT, STTOutputContract } from './stt.js';
import { pcmBytes, validateFrame } from './stt_audio.js';
import {
  type RequestOptions,
  type SDK,
  type SDKClient,
  type SDKStream,
  abortable,
  cancelled,
  mapError,
} from './stt_sdk.js';

interface Utterance {
  audio: AsyncIterableQueue<Uint8Array>;
  done: Promise<void>;
  complete: () => void;
  start: number;
  end?: number;
  audioDuration: number;
  publishing: boolean;
  interim?: stt.SpeechEvent;
  final?: stt.SpeechEvent;
  usage?: stt.SpeechEvent;
}

/** @internal Concurrent uploads with speech-ordered publication. */
export class SpeechStream extends stt.SpeechStream {
  label = 'rime.STT.SpeechStream';
  private readonly stopped: Promise<void>;
  private settle!: () => void;
  private detector?: VADStream;
  private inputResampler?: AudioResampler;
  private inputRate?: number;
  private closing?: Promise<void>;

  constructor(
    owner: STT,
    private readonly vad: VAD,
    private readonly contract: STTOutputContract,
    private readonly connection: APIConnectOptions,
    private readonly context: {
      getClient(): Promise<{ sdk: SDK; client: SDKClient }>;
      snapshot(): Pick<RequestOptions, 'language' | 'mode' | 'contextTerms'>;
    },
    private readonly forget: () => void,
  ) {
    super(owner, undefined, { ...connection, maxRetry: 0 });
    this.stopped = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  override pushFrame(frame: AudioFrame): void {
    validateFrame(frame);
    if (frame.channels !== 1)
      throw new APIError('Rime streaming requires mono audio', { retryable: false });
    if (this.closed || this.input.closed) throw new Error('Rime STT stream input is closed');
    if (this.inputRate !== undefined && frame.sampleRate !== this.inputRate)
      throw new APIError('Rime streaming input sample rate changed within a segment', {
        retryable: false,
      });
    this.inputRate = frame.sampleRate;
    const copy = new AudioFrame(
      new Int16Array(frame.data),
      frame.sampleRate,
      1,
      frame.samplesPerChannel,
    );
    if (frame.sampleRate !== 16000)
      this.inputResampler ??= new AudioResampler(frame.sampleRate, 16000, 1);
    if (this.inputResampler) {
      for (const converted of this.inputResampler.push(copy)) super.pushFrame(converted);
    } else super.pushFrame(copy);
  }

  private drainResampler(): void {
    this.inputRate = undefined;
    if (!this.inputResampler) return;
    for (const frame of this.inputResampler.flush()) super.pushFrame(frame);
    this.inputResampler.close();
    this.inputResampler = undefined;
  }

  override flush(): void {
    this.drainResampler();
    super.flush();
  }
  override endInput(): void {
    this.drainResampler();
    super.endInput();
  }

  protected async run(): Promise<void> {
    const controller = new AbortController();
    const stop = () => controller.abort(cancelled());
    this.abortSignal.addEventListener('abort', stop, { once: true });
    if (this.abortSignal.aborted) stop();
    const signal = controller.signal;
    const ordered = new AsyncIterableQueue<Utterance>();
    const pending = new Set<Utterance>();
    const requests = new Set<Promise<void>>();
    let pendingBytes = 0;
    let fail!: (error: unknown) => void;
    const failure = new Promise<never>((_, reject) => {
      fail = reject;
    });
    void failure.catch(() => {});
    const tasks: Promise<void>[] = [];

    const publish = (utterance: Utterance, event: stt.SpeechEvent) => {
      signal.throwIfAborted();
      if (utterance.publishing) this.queue.put(event);
      else if (event.type === stt.SpeechEventType.INTERIM_TRANSCRIPT) utterance.interim = event;
      else if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT) utterance.final = event;
      else utterance.usage = event;
    };
    const source = async function* (utterance: Utterance, requestSignal: AbortSignal) {
      while (true) {
        const result = await utterance.audio.next({ signal: requestSignal });
        if (result.done) break;
        pendingBytes -= result.value.byteLength;
        yield result.value;
      }
    };
    const transcribe = async (utterance: Utterance, options: RequestOptions) => {
      let sdk: SDK | undefined;
      let stream: SDKStream | undefined;
      const deadline = new AbortController();
      const requestSignal = AbortSignal.any([signal, deadline.signal]);
      const timer = setTimeout(
        () =>
          deadline.abort(
            new APITimeoutError({
              message: 'Rime streaming STT request timed out',
              options: { retryable: false },
            }),
          ),
        this.connection.timeoutMs,
      );
      try {
        const initialized = await abortable(this.context.getClient(), requestSignal);
        sdk = initialized.sdk;
        stream = initialized.client.stt.stream(source(utterance, requestSignal), {
          ...options,
          signal: requestSignal,
        });
        let text = '';
        let final: stt.SpeechEvent | undefined;
        for await (const update of stream) {
          requestSignal.throwIfAborted();
          text = update.kind === 'delta' ? text + update.text : update.text;
          const event: stt.SpeechEvent = {
            type:
              update.kind === 'final'
                ? stt.SpeechEventType.FINAL_TRANSCRIPT
                : stt.SpeechEventType.INTERIM_TRANSCRIPT,
            requestId: stream.requestId ?? '',
            alternatives: [
              {
                text,
                language: asLanguageCode(update.language ?? options.language),
                startTime: 0,
                endTime: 0,
                confidence: 0,
              },
            ],
          };
          if (update.kind === 'final') final = event;
          else publish(utterance, event);
        }
        requestSignal.throwIfAborted();
        if (!final || utterance.end === undefined)
          throw new APIError('Rime streaming STT ended without confirmed completion', {
            retryable: false,
          });
        publish(utterance, { ...final, speechEndTime: utterance.end });
        publish(utterance, {
          type: stt.SpeechEventType.RECOGNITION_USAGE,
          requestId: stream.requestId ?? '',
          recognitionUsage: { audioDuration: utterance.audioDuration },
        });
        utterance.complete();
      } catch (error) {
        throw mapError(
          error,
          sdk,
          true,
          requestSignal.aborted ? mapError(requestSignal.reason, sdk, true) : undefined,
        );
      } finally {
        clearTimeout(timer);
        await stream?.cancel().catch(() => {});
      }
    };
    const upload = (utterance: Utterance, frames: AudioFrame[]) => {
      for (const frame of frames) {
        validateFrame(frame);
        if (frame.channels !== 1 || frame.sampleRate !== 16000)
          throw new APIError('Rime streaming requires mono 16 kHz VAD frames', {
            retryable: false,
          });
        if (pendingBytes + frame.data.byteLength > 320000)
          throw new APIError('Rime streaming audio backlog exceeded 10 seconds', {
            retryable: false,
          });
        const data = pcmBytes(frame);
        pendingBytes += data.byteLength;
        utterance.audioDuration += frame.samplesPerChannel / frame.sampleRate;
        utterance.audio.put(data);
      }
    };
    const finish = (utterance: Utterance) => {
      utterance.end ??= Date.now();
      utterance.audio.close();
    };
    const segment = async (): Promise<boolean> => {
      signal.throwIfAborted();
      const detector = this.vad.stream();
      this.detector = detector;
      let eof = false;
      let active: Utterance | undefined;
      const forward = async () => {
        while (true) {
          const result = await this.input.next({ signal });
          if (result.done) {
            eof = true;
            break;
          }
          if (result.value === SpeechStream.FLUSH_SENTINEL) break;
          detector.pushFrame(result.value);
        }
        detector.endInput();
      };
      const recognize = async () => {
        while (true) {
          const result = await abortable(detector.next(), signal);
          if (result.done) break;
          const event = result.value;
          if (event.type === VADEventType.START_OF_SPEECH) {
            if (active) throw new APIError('Overlapping Rime VAD utterances', { retryable: false });
            if (pending.size >= 8)
              throw new APIError('Rime streaming pending utterance limit exceeded', {
                retryable: false,
              });
            let complete!: () => void;
            const done = new Promise<void>((resolve) => {
              complete = resolve;
            });
            active = {
              audio: new AsyncIterableQueue(),
              done,
              complete,
              start: Date.now(),
              audioDuration: 0,
              publishing: false,
            };
            const options: RequestOptions = {
              ...this.context.snapshot(),
              outputContract: this.contract,
              timeout: this.connection.timeoutMs / 1000,
              signal,
            };
            upload(active, event.frames);
            pending.add(active);
            ordered.put(active);
            const task = transcribe(active, options);
            requests.add(task);
            void task.then(
              () => requests.delete(task),
              (error) => {
                requests.delete(task);
                if (!signal.aborted) fail(error);
              },
            );
          } else if (event.type === VADEventType.INFERENCE_DONE && active)
            upload(active, event.frames);
          else if (event.type === VADEventType.END_OF_SPEECH && active) {
            // END contains the complete utterance. Its audio has already been uploaded.
            active.end = Date.now() - event.silenceDuration - event.inferenceDuration;
            finish(active);
            active = undefined;
          }
        }
        if (active) finish(active);
      };
      const work = [forward(), recognize()];
      try {
        await Promise.all(work);
        return eof;
      } catch (error) {
        fail(error);
        stop();
        throw error;
      } finally {
        try {
          await detector.close();
        } catch {
          // Cleanup must not replace the request outcome or prevent joining other work.
        }
        this.detector = undefined;
        await Promise.allSettled(work);
      }
    };
    const readAudio = async () => {
      while (!(await segment())) {
        /* flush resets segmentation, requests remain in flight */
      }
      ordered.close();
    };
    const emitResults = async () => {
      while (true) {
        const result = await ordered.next({ signal });
        if (result.done) break;
        const utterance = result.value;
        this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH, createdAt: utterance.start });
        utterance.publishing = true;
        for (const event of [utterance.interim, utterance.final, utterance.usage])
          if (event) this.queue.put(event);
        utterance.interim = utterance.final = utterance.usage = undefined;
        await abortable(utterance.done, signal);
        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH, speechEndTime: utterance.end });
        pending.delete(utterance);
      }
    };
    try {
      signal.throwIfAborted();
      tasks.push(readAudio(), emitResults());
      await Promise.race([Promise.all(tasks), failure]);
    } finally {
      stop();
      try {
        await this.detector?.close();
      } catch {
        // A caller-supplied stream may throw synchronously while releasing resources.
      }
      for (const utterance of pending) if (!utterance.audio.closed) utterance.audio.close();
      await Promise.allSettled([...tasks, ...requests]);
      this.inputResampler?.close();
      this.inputResampler = undefined;
      if (!this.input.closed) this.input.close();
      this.abortSignal.removeEventListener('abort', stop);
      this.forget();
      this.settle();
    }
  }

  /** Cancel and join SDK readers/uploads and the owned VAD stream. */
  override close(): Promise<void> {
    if (!this.closing) {
      this.inputResampler?.close();
      this.inputResampler = undefined;
      super.close();
      this.closing = this.stopped;
    }
    return this.closing;
  }
}
