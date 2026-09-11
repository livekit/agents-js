// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type APIConnectOptions, AudioByteStream, log, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type {
  PipelineConstraints,
  Speko,
  SynthesizeResult,
  SynthesizeStreamResult,
} from '@spekoai/sdk';
import { parseWav, pcmSampleRateFromContentType } from './audio.js';
import { type SpekoClientOptions, createSpekoClient } from './client.js';
import { type Intent, validateIntent } from './intent.js';

/**
 * Default output sample rate advertised to the LiveKit `AgentSession`. Speko's
 * router pins the upstream provider to 24 kHz mono PCM (Cartesia's native
 * format, ElevenLabs via `output_format=pcm_24000`). Any provider that emits
 * `audio/mpeg` is rejected - v1 ships no MP3 decoder.
 */
const DEFAULT_SAMPLE_RATE = 24_000;
const NUM_CHANNELS = 1;

/**
 * Options for the Speko TTS component.
 *
 * @public
 */
export interface TTSOptions extends SpekoClientOptions {
  /** Routing intent sent with every synthesis request. */
  intent: Intent;
  /** Voice id override forwarded to the Speko proxy. */
  voice?: string;
  /** Forwarded speech speed override. */
  speed?: number;
  /**
   * Output sample rate advertised to the LiveKit agent. Must match what the
   * upstream provider actually emits, otherwise playback will be pitched.
   * Defaults to 24000 (Cartesia Sonic default).
   */
  sampleRate?: number;
  /** Optional allow-list constraints. */
  constraints?: PipelineConstraints;
}

/**
 * LiveKit Agents TTS plugin that delegates synthesis to the Speko proxy
 * (`POST /v1/synthesize`). The router picks the best TTS provider per intent
 * and fails over automatically.
 *
 * The Speko REST response streams audio bytes. `voice.AgentSession` wraps
 * non-streaming TTS plugins with `tts.StreamAdapter` automatically.
 *
 * **Audio format constraint**: the plugin accepts either `audio/pcm;rate=NNNN`
 * or `audio/wav`. The Speko router asks every supported TTS for PCM upstream
 * (Cartesia natively, ElevenLabs via `output_format=pcm_24000`), so MP3 should
 * never reach the plugin in v1; if it does, `decodeSynthesisResult` throws.
 *
 * @public
 */
export class TTS extends tts.TTS {
  /** Human-readable model label used by LiveKit metrics and logs. */
  label = 'speko.TTS';
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #voice?: string;
  readonly #speed?: number;
  readonly #sampleRate: number;
  readonly #constraints: PipelineConstraints | undefined;

  constructor(options: TTSOptions) {
    validateIntent(options.intent);
    const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    super(sampleRate, NUM_CHANNELS, { streaming: false });
    this.#speko = createSpekoClient(options);
    this.#intent = options.intent;
    this.#voice = options.voice;
    this.#speed = options.speed;
    this.#sampleRate = sampleRate;
    this.#constraints = options.constraints;
  }

  /** Provider identifier reported to LiveKit metrics. */
  override get provider(): string {
    return 'speko';
  }

  /** Model identifier reported to LiveKit metrics. */
  override get model(): string {
    return 'speko-router';
  }

  /** Synthesize a single text segment through Speko's TTS router. */
  override synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new ChunkedStream({
      text,
      tts: this,
      speko: this.#speko,
      intent: this.#intent,
      voice: this.#voice,
      speed: this.#speed,
      expectedSampleRate: this.#sampleRate,
      constraints: this.#constraints,
      connOptions,
      abortSignal,
    });
  }

  /**
   * Native text-input streaming is not supported; LiveKit wraps this TTS with
   * `tts.StreamAdapter` when used in `voice.AgentSession`.
   */
  override stream(_options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    throw new Error(
      'speko.TTS does not support native text-input streaming; it synthesizes one sentence request at a time. ' +
        'Pass it directly to `voice.AgentSession`, or wrap it manually with ' +
        '`new tts.StreamAdapter(spekoTts, sentenceTokenizer)` when implementing a custom TTS node.',
    );
  }
}

interface ChunkedStreamArgs {
  text: string;
  tts: TTS;
  speko: Speko;
  intent: Intent;
  voice?: string;
  speed?: number;
  expectedSampleRate: number;
  constraints?: PipelineConstraints;
  connOptions?: APIConnectOptions;
  abortSignal?: AbortSignal;
}

/**
 * Chunked TTS stream that forwards sentence-sized synthesis requests to Speko.
 *
 * @public
 */
class ChunkedStream extends tts.ChunkedStream {
  label = 'speko.ChunkedStream';
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #voice?: string;
  readonly #speed?: number;
  readonly #expectedSampleRate: number;
  readonly #constraints: PipelineConstraints | undefined;

  constructor(args: ChunkedStreamArgs) {
    super(args.text, args.tts, args.connOptions, args.abortSignal);
    this.#speko = args.speko;
    this.#intent = args.intent;
    this.#voice = args.voice;
    this.#speed = args.speed;
    this.#expectedSampleRate = args.expectedSampleRate;
    this.#constraints = args.constraints;
  }

  protected async run(): Promise<void> {
    // Diagnostic logging is intentionally verbose around the synthesize
    // boundary because the LiveKit Agents framework emits "TTS stream
    // stalled after producing audio, forcing close" with zero context
    // about which sentence stalled or what content-type came back. With
    // these logs we can grep the worker container for `[speko.TTS]` and
    // see the full timeline per turn.
    const logger = log();
    const requestId = crypto.randomUUID();
    const t0 = Date.now();
    logger.info(
      {
        requestId,
        textLength: this.inputText.length,
        textPreview: this.inputText.slice(0, 80),
        voice: this.#voice,
        language: this.#intent.language,
        optimizeFor: this.#intent.optimizeFor,
        constraints: this.#constraints,
        expectedSampleRate: this.#expectedSampleRate,
      },
      '[speko.TTS] synthesize:start',
    );

    let streamed: SynthesizeStreamResult;
    try {
      streamed = await this.#speko.synthesizeStream(
        this.inputText,
        {
          language: this.#intent.language,
          ...(this.#intent.region !== undefined && { region: this.#intent.region }),
          ...(this.#intent.optimizeFor !== undefined && {
            optimizeFor: this.#intent.optimizeFor,
          }),
          ...(this.#voice !== undefined && { voice: this.#voice }),
          ...(this.#speed !== undefined && { speed: this.#speed }),
          ...(this.#constraints !== undefined && { constraints: this.#constraints }),
        },
        this.abortSignal,
      );
    } catch (err) {
      logger.error(
        {
          requestId,
          elapsedMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        },
        '[speko.TTS] synthesize:error',
      );
      throw err;
    }

    const t1 = Date.now();
    if (streamed.contentType.toLowerCase().startsWith('audio/pcm')) {
      await this.#streamPcmResult(streamed, requestId, t0, t1);
      return;
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of streamed) chunks.push(chunk);
    const result: SynthesizeResult = {
      audio: concatChunks(chunks),
      contentType: streamed.contentType,
      provider: streamed.provider,
      model: streamed.model,
      failoverCount: streamed.failoverCount,
      scoresRunId: streamed.scoresRunId,
    };
    logger.info(
      {
        requestId,
        elapsedMs: t1 - t0,
        contentType: result.contentType,
        audioBytes: result.audio.byteLength,
        provider: result.provider,
      },
      '[speko.TTS] synthesize:response',
    );

    const { pcm, sampleRate, channels } = decodeSynthesisResult(result);

    if (sampleRate !== this.#expectedSampleRate) {
      logger.error(
        {
          requestId,
          actualSampleRate: sampleRate,
          expectedSampleRate: this.#expectedSampleRate,
        },
        '[speko.TTS] synthesize:sample-rate-mismatch',
      );
      throw new Error(
        `speko.TTS: provider returned audio at ${sampleRate} Hz but the TTS was ` +
          `configured for ${this.#expectedSampleRate} Hz. Either set ` +
          `\`sampleRate: ${sampleRate}\` on speko.TTS or pin the Speko router to a ` +
          `provider that matches the expected rate.`,
      );
    }

    const samplesPerFrame = Math.round(sampleRate / 50);
    const bstream = new AudioByteStream(sampleRate, channels, samplesPerFrame);
    const frames = [...bstream.write(pcm), ...bstream.flush()];

    if (frames.length === 0) {
      logger.error({ requestId }, '[speko.TTS] synthesize:empty-frames');
      throw new Error('speko.TTS: provider returned empty audio');
    }

    logger.info(
      {
        requestId,
        frameCount: frames.length,
        sampleRate,
        channels,
        pcmBytes: pcm.byteLength,
        durationMs: Math.round((pcm.byteLength / 2 / sampleRate) * 1000),
        decodeMs: Date.now() - t1,
      },
      '[speko.TTS] synthesize:frames-ready',
    );

    this.#pushFrames(frames, requestId);

    logger.info({ requestId, totalElapsedMs: Date.now() - t0 }, '[speko.TTS] synthesize:done');
  }

  async #streamPcmResult(
    streamed: SynthesizeStreamResult,
    requestId: string,
    startedAt: number,
    responseAt: number,
  ): Promise<void> {
    const logger = log();
    const sampleRate = pcmSampleRateFromContentType(
      streamed.contentType.toLowerCase(),
      this.#expectedSampleRate,
    );
    if (sampleRate !== this.#expectedSampleRate) {
      throw new Error(
        `speko.TTS: provider returned audio at ${sampleRate} Hz but the TTS was ` +
          `configured for ${this.#expectedSampleRate} Hz.`,
      );
    }

    const samplesPerFrame = Math.round(sampleRate / 50);
    const bstream = new AudioByteStream(sampleRate, NUM_CHANNELS, samplesPerFrame);
    let pending: AudioFrame | undefined;
    let pushed = 0;
    let bytes = 0;
    let firstFrameMs: number | undefined;
    const flush = (final: boolean) => {
      if (!pending) return;
      this.queue.put({
        requestId,
        segmentId: requestId,
        frame: pending,
        final,
      });
      pending = undefined;
      pushed += 1;
      firstFrameMs ??= Date.now() - startedAt;
    };

    for await (const chunk of streamed) {
      bytes += chunk.byteLength;
      for (const frame of bstream.write(chunk)) {
        flush(false);
        pending = frame;
      }
    }
    for (const frame of bstream.flush()) {
      flush(false);
      pending = frame;
    }
    flush(true);

    if (pushed === 0) {
      logger.error({ requestId }, '[speko.TTS] synthesize:empty-frames');
      throw new Error('speko.TTS: provider returned empty audio');
    }

    logger.info(
      {
        requestId,
        responseMs: responseAt - startedAt,
        firstFrameMs,
        totalElapsedMs: Date.now() - startedAt,
        frameCount: pushed,
        pcmBytes: bytes,
        provider: streamed.provider,
      },
      '[speko.TTS] synthesize:streamed-pcm-done',
    );
  }

  #pushFrames(frames: AudioFrame[], requestId: string): void {
    const logger = log();
    const t0 = Date.now();
    let pushed = 0;
    let pending: AudioFrame | undefined;
    const flush = (final: boolean) => {
      if (!pending) return;
      this.queue.put({
        requestId,
        segmentId: requestId,
        frame: pending,
        final,
      });
      pending = undefined;
      pushed += 1;
    };

    for (const frame of frames) {
      flush(false);
      pending = frame;
    }
    flush(true);

    logger.info(
      {
        requestId,
        pushedCount: pushed,
        expectedCount: frames.length,
        pushMs: Date.now() - t0,
      },
      '[speko.TTS] pushFrames:done',
    );
  }
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Decode a `SynthesizeResult` into raw PCM + sample rate + channel count.
 * Branches on `contentType`:
 *
 * - `audio/pcm;rate=NNNN` returns the raw payload, with the rate parsed from MIME parameters.
 *   Cartesia's contract is mono, so channels is pinned to one channel.
 * - `audio/wav` / `audio/x-wav` returns the WAV body after `parseWav` strips the header. The
 *   embedded channel count is validated - v1 only handles mono, and a stereo
 *   response would otherwise be fed to a mono `AudioByteStream` and played at
 *   half speed with L/R mixed.
 * - `audio/mpeg` or anything else throws, documented v1 limitation.
 *
 * Exported for unit testing.
 *
 * @public
 */
export function decodeSynthesisResult(result: SynthesizeResult): {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
} {
  const contentType = result.contentType.toLowerCase();

  if (contentType.startsWith('audio/pcm')) {
    return {
      pcm: result.audio,
      sampleRate: pcmSampleRateFromContentType(contentType, DEFAULT_SAMPLE_RATE),
      channels: NUM_CHANNELS,
    };
  }

  if (contentType.startsWith('audio/wav') || contentType.startsWith('audio/x-wav')) {
    const { pcm, sampleRate, channels } = parseWav(result.audio);
    if (channels !== NUM_CHANNELS) {
      throw new Error(
        `speko.TTS: WAV response has ${channels} channels but the plugin is ` +
          `configured for ${NUM_CHANNELS}. Configure the Speko router to return ` +
          `mono audio, or pin a mono-only provider.`,
      );
    }
    return { pcm, sampleRate, channels };
  }

  if (contentType.startsWith('audio/mpeg')) {
    throw new Error(
      `speko.TTS: received ${result.contentType} from provider "${result.provider}". ` +
        'v1 only supports raw PCM (`audio/pcm;rate=NNNN`) and WAV (`audio/wav`). ' +
        'Configure your Speko routing intent so Cartesia is preferred, or pin the ' +
        'TTS provider explicitly.',
    );
  }

  throw new Error(
    `speko.TTS: unsupported content type "${result.contentType}" from provider ` +
      `"${result.provider}". Expected audio/pcm, audio/wav, or (in future) audio/mpeg.`,
  );
}
