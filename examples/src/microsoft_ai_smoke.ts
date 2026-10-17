// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Explicit-opt-in, bounded Microsoft AI speech smoke test without LiveKit Cloud.
 *
 * Confirm the plugin README's STT protocol or Azure Speech TTS endpoint before
 * using --run-live. No audio or transcripts are saved or printed. The STT fixture
 * and expected-text file must be user-approved inputs. --tts alone needs no STT access.
 */
import { type APIConnectOptions, APIError, stt } from '@livekit/agents';
import * as microsoft from '@livekit/agents-plugin-microsoft';
import { AudioFrame } from '@livekit/rtc-node';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TTS_TEXT = 'Hello, this is a Microsoft AI voice test.';
export const CONNECT_OPTIONS: APIConnectOptions = {
  maxRetry: 0,
  retryIntervalMs: 2_000,
  timeoutMs: 10_000,
};
const MAX_DURATION_SECONDS = 5;
const RUN_TIMEOUT_MS = 50_000;

export class ValidationError extends Error {}

export type Options = {
  runLive: boolean;
  tts: boolean;
  sttWav?: string;
  expectedTextFile?: string;
  envFile?: string;
};

function usage(): string {
  return `Usage: microsoft_ai_smoke.ts --run-live [--tts] [STT options]

Options:
  --run-live                 approve live requests for the selected services
  --tts                      send exactly one request for ${JSON.stringify(TTS_TEXT)}
  --stt-wav PATH             approved PCM16 mono 16 kHz WAV, at most 5 seconds
  --expected-text-file PATH  approved expected transcript (not logged)
  --env-file PATH            explicit dotenv file; otherwise MICROSOFT_AI_ENV_FILE
  --help                     show this help
`;
}

export function parseArgs(argv: string[]): Options | null {
  const options: Options = { runLive: false, tts: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') return null;
    if (arg === '--run-live') options.runLive = true;
    else if (arg === '--tts') options.tts = true;
    else if (arg === '--stt-wav') options.sttWav = requiredValue(argv, ++index, arg);
    else if (arg === '--expected-text-file') {
      options.expectedTextFile = requiredValue(argv, ++index, arg);
    } else if (arg === '--env-file') options.envFile = requiredValue(argv, ++index, arg);
    else throw new ValidationError(`Unknown argument: ${arg}`);
  }
  return options;
}

function requiredValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new ValidationError(`${option} requires a path`);
  return value;
}

export function checkEnvFilePermissions(path: string): void {
  if (process.platform !== 'win32' && (statSync(path).mode & 0o777) !== 0o600) {
    throw new ValidationError(
      'The selected dotenv file must have permissions 0600; no requests sent',
    );
  }
}

export function readFixture(path: string): Int16Array {
  const stat = statSync(path);
  if (stat.size > 1024 * 1024) {
    throw new ValidationError('The approved WAV fixture must be at most 1 MiB');
  }
  const wav = readFileSync(path);
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new ValidationError('The approved fixture must be a WAV file');
  }

  let format: { encoding: number; channels: number; sampleRate: number; bits: number } | undefined;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > wav.length) throw new ValidationError('The approved WAV fixture is truncated');
    if (id === 'fmt ' && size >= 16) {
      format = {
        encoding: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4),
        bits: wav.readUInt16LE(start + 14),
      };
    } else if (id === 'data' && pcm === undefined) {
      pcm = wav.subarray(start, end);
    }
    offset = end + (size & 1);
  }

  if (
    !format ||
    format.encoding !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== 16_000 ||
    format.bits !== 16
  ) {
    throw new ValidationError('The approved fixture must be PCM16 mono WAV at 16000 Hz');
  }
  if (
    !pcm ||
    pcm.length === 0 ||
    pcm.length % 2 !== 0 ||
    pcm.length > 16_000 * 2 * MAX_DURATION_SECONDS
  ) {
    throw new ValidationError('The approved speech fixture must be between 0 and 5 seconds');
  }
  const copy = Uint8Array.from(pcm);
  return new Int16Array(copy.buffer);
}

export function normalize(text: string): string {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).join(' ');
}

export function readExpected(path: string): string {
  const bytes = readFileSync(path);
  if (bytes.length > 4096) {
    throw new ValidationError('The expected-text file must be at most 4096 bytes');
  }
  const expected = bytes.toString('utf8').trim();
  if (!normalize(expected) || expected.length > 256) {
    throw new ValidationError(
      'The expected transcript must contain words and at most 256 characters',
    );
  }
  return expected;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function checkStt(
  provider: microsoft.STT,
  pcm: Int16Array,
  expected: string,
  signal: AbortSignal,
): Promise<void> {
  const stream = provider.stream({ connOptions: CONNECT_OPTIONS });
  const closeOnAbort = () => stream.close();
  signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    const send = async () => {
      for (let offset = 0; offset < pcm.length; offset += 320) {
        const chunk = pcm.slice(offset, offset + 320);
        stream.pushFrame(new AudioFrame(chunk, 16_000, 1, chunk.length));
        await delay((chunk.length / 16_000) * 1000, signal);
      }
      stream.endInput();
    };
    const receive = async () => {
      const transcripts: string[] = [];
      for await (const event of stream) {
        if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT) {
          const text = event.alternatives?.[0]?.text;
          if (text !== undefined) transcripts.push(text);
        }
      }
      return transcripts;
    };
    const [, transcripts] = await Promise.all([send(), receive()]);
    if (transcripts.length !== 1 || normalize(transcripts[0]!) !== normalize(expected)) {
      throw new ValidationError(
        'STT did not match the complete expected transcript, including its tail',
      );
    }
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
    stream.close();
  }
  console.log('STT: one finalized item matched the expected words; transcript not printed.');
}

export async function checkTts(provider: microsoft.TTS, signal: AbortSignal): Promise<void> {
  const started = performance.now();
  const stream = provider.synthesize(TTS_TEXT, CONNECT_OPTIONS, signal);
  let samples = 0;
  let finals = 0;
  let frames = 0;
  try {
    for await (const event of stream) {
      if (event.frame.sampleRate !== provider.sampleRate || event.frame.channels !== 1) {
        throw new ValidationError('TTS output has an unexpected audio format');
      }
      samples += event.frame.samplesPerChannel;
      finals += Number(event.final);
      frames += 1;
    }
  } finally {
    stream.close();
  }
  if (samples === 0 || finals !== 1) {
    throw new ValidationError('TTS did not return exactly one nonempty final audio segment');
  }
  const elapsed = (performance.now() - started) / 1000;
  console.log(
    `TTS: ${frames} PCM16 mono frames at ${provider.sampleRate} Hz; ` +
      `audio_duration=${(samples / provider.sampleRate).toFixed(3)}s; ` +
      `elapsed=${elapsed.toFixed(3)}s (client synthesis call through stream closure, ` +
      'not model TTFA). ' +
      'Audio not saved or played.',
  );
}

export async function run(
  options: Options,
  pcm: Int16Array | undefined,
  expected: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  let speechToText: microsoft.STT | undefined;
  let textToSpeech: microsoft.TTS | undefined;
  try {
    // Construct every selected service before opening a socket or issuing HTTP.
    if (pcm && expected) {
      speechToText = new microsoft.STT({ vad: null, envFile: options.envFile });
    }
    if (options.tts) {
      textToSpeech = new microsoft.TTS({
        envFile: options.envFile,
        requestTimeout: 20_000,
        maxAudioBytes: 1024 * 1024,
      });
    }
    if (speechToText && pcm && expected) await checkStt(speechToText, pcm, expected, signal);
    if (textToSpeech) await checkTts(textToSpeech, signal);
  } finally {
    await Promise.allSettled([speechToText?.close(), textToSpeech?.close()]);
  }
  console.log('All selected providers and transports closed.');
}

export function validateOptions(options: Options, dumpTts = process.env.LK_DUMP_TTS): void {
  if (!options.runLive) {
    throw new ValidationError('No requests sent. Explicit --run-live approval is required');
  }
  if (!options.tts && !options.sttWav) {
    throw new ValidationError('Select --tts and/or --stt-wav');
  }
  if (Boolean(options.sttWav) !== Boolean(options.expectedTextFile)) {
    throw new ValidationError('--stt-wav and --expected-text-file must be supplied together');
  }
  if ((dumpTts ?? '0') !== '0') {
    throw new ValidationError('Unset LK_DUMP_TTS: smoke tests must not write audio captures');
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (!options) {
    process.stdout.write(usage());
    return;
  }
  validateOptions(options);

  options.envFile ??= process.env.MICROSOFT_AI_ENV_FILE;
  if (options.envFile) checkEnvFilePermissions(options.envFile);
  const pcm = options.sttWav ? readFixture(options.sttWav) : undefined;
  const expected = options.expectedTextFile ? readExpected(options.expectedTextFile) : undefined;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new ValidationError('Smoke test exceeded its 50-second limit')),
    RUN_TIMEOUT_MS,
  );
  try {
    await run(options, pcm, expected, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Filesystem/transport errors may contain private paths or endpoint information.
    // Provider APIError and local validation messages are deliberately safe to print.
    const detail =
      error instanceof APIError || error instanceof ValidationError
        ? error.message
        : error instanceof Error
          ? error.name
          : 'Unknown error';
    process.stderr.write(`Smoke test failed: ${detail}\n`);
    process.exitCode = 1;
  });
}
