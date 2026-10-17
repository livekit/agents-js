// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type ChatContext, type ChatMessage, stt, voice } from '@livekit/agents';
import type * as microsoft from '@livekit/agents-plugin-microsoft';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EchoAgent, reportEchoSynthesisError } from './microsoft_ai_echo.js';
import {
  TTS_TEXT,
  checkEnvFilePermissions,
  checkStt,
  checkTts,
  parseArgs,
  readExpected,
  readFixture,
  validateOptions,
} from './microsoft_ai_smoke.js';

const temporaryDirectories: string[] = [];

function temporaryFile(name: string, contents: string | Uint8Array): string {
  const directory = mkdtempSync(join(tmpdir(), 'microsoft-ai-example-'));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

function wav(samples: number, sampleRate = 16_000, channels = 1): Buffer {
  const pcm = Buffer.alloc(samples * channels * 2, 1);
  const result = Buffer.alloc(44 + pcm.length);
  result.write('RIFF', 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(channels, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * channels * 2, 28);
  result.writeUInt16LE(channels * 2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36);
  result.writeUInt32LE(pcm.length, 40);
  pcm.copy(result, 44);
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe('Microsoft AI echo example', () => {
  function agentWithSession() {
    const handle = { addDoneCallback: vi.fn() };
    const session = { say: vi.fn(() => handle), generateReply: vi.fn() };
    class TestEchoAgent extends EchoAgent {
      override get session(): voice.AgentSession {
        return session as unknown as voice.AgentSession;
      }
    }
    return { agent: new TestEchoAgent(), handle, session };
  }

  async function completeTurn(agent: EchoAgent, text?: string) {
    return agent.onUserTurnCompleted(
      {} as ChatContext,
      { textContent: text } as unknown as ChatMessage,
    );
  }

  it.each(['Ready now.', 'The final word.', 'Repeat this.'])(
    'echoes exact completed text once: %s',
    async (text) => {
      const { agent, handle, session } = agentWithSession();
      await expect(completeTurn(agent, text)).rejects.toBeInstanceOf(voice.StopResponse);
      expect(session.say).toHaveBeenCalledOnce();
      expect(session.say).toHaveBeenCalledWith(text, {
        allowInterruptions: true,
        addToChatCtx: false,
      });
      expect(handle.addDoneCallback).toHaveBeenCalledOnce();
      expect(session.generateReply).not.toHaveBeenCalled();
    },
  );

  it('does not deduplicate repeated text in distinct turns', async () => {
    const { agent, session } = agentWithSession();
    await expect(completeTurn(agent, 'Same words.')).rejects.toBeInstanceOf(voice.StopResponse);
    await expect(completeTurn(agent, 'Same words.')).rejects.toBeInstanceOf(voice.StopResponse);
    expect(session.say).toHaveBeenCalledTimes(2);
  });

  it('does not synthesize an empty completed turn', async () => {
    const { agent, session } = agentWithSession();
    await expect(completeTurn(agent)).rejects.toBeInstanceOf(voice.StopResponse);
    expect(session.say).not.toHaveBeenCalled();
  });

  it('logs only the synthesis error name', () => {
    const logger = { error: vi.fn() };
    reportEchoSynthesisError(new RuntimeError('dummy-private-transcript'), logger);
    expect(logger.error).toHaveBeenCalledWith('Echo synthesis failed (RuntimeError)');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('dummy-private-transcript');
  });
});

class RuntimeError extends Error {
  override name = 'RuntimeError';
}

describe('Microsoft AI smoke example', () => {
  it.each([
    { args: [] },
    { args: ['--tts'] },
    { args: ['--run-live'] },
    { args: ['--run-live', '--stt-wav', 'unused.wav'] },
    { args: ['--run-live', '--expected-text-file', 'unused.txt'] },
  ])('requires explicit opt-in and a complete service selection: $args', ({ args }) => {
    const options = parseArgs(args)!;
    expect(() => validateOptions(options, '0')).toThrow();
  });

  it('accepts a complete STT fixture/expected-text pair', () => {
    const options = parseArgs([
      '--run-live',
      '--stt-wav',
      'approved.wav',
      '--expected-text-file',
      'approved.txt',
    ])!;
    expect(() => validateOptions(options, '0')).not.toThrow();
  });

  it('refuses LK_DUMP_TTS before running a selected service', () => {
    const options = parseArgs(['--run-live', '--tts'])!;
    expect(() => validateOptions(options, '1')).toThrow(/Unset LK_DUMP_TTS/);
  });

  it.runIf(process.platform !== 'win32')('requires owner-only dotenv permissions', () => {
    const path = temporaryFile('endpoints.env', '');
    chmodSync(path, 0o644);
    expect(() => checkEnvFilePermissions(path)).toThrow(/permissions 0600/);
    chmodSync(path, 0o600);
    expect(() => checkEnvFilePermissions(path)).not.toThrow();
  });

  it.each([1, 1307, 80_000])('accepts an approved fixture of %i samples exactly', (samples) => {
    const pcm = readFixture(temporaryFile('fixture.wav', wav(samples)));
    expect(pcm).toHaveLength(samples);
    expect(Buffer.from(pcm.buffer)).toEqual(wav(samples).subarray(44));
  });

  it.each([
    { name: 'empty audio', contents: wav(0) },
    { name: 'over five seconds', contents: wav(80_001) },
    { name: 'wrong sample rate', contents: wav(100, 24_000) },
    { name: 'stereo', contents: wav(100, 16_000, 2) },
    { name: 'truncated', contents: wav(100).subarray(0, -2) },
    { name: 'over one MiB', contents: Buffer.alloc(1024 * 1024 + 1) },
  ])('rejects an invalid fixture: $name', ({ contents }) => {
    expect(() => readFixture(temporaryFile('fixture.wav', contents))).toThrow();
  });

  it.each([
    ['', 'empty'],
    ['  ', 'whitespace'],
    ['...', 'no words'],
    ['a'.repeat(257), 'character limit'],
    ['b'.repeat(4097), 'byte limit'],
  ])('rejects bounded expected text: %s (%s)', (text) => {
    expect(() => readExpected(temporaryFile('expected.txt', text))).toThrow();
  });

  it.each([
    { expected: 'Turn 1.', succeeds: true },
    { expected: 'Turn 1 missing tail', succeeds: false },
  ])(
    'checks the complete STT result without printing it: $expected',
    async ({ expected, succeeds }) => {
      const stream = {
        pushFrame: vi.fn(),
        endInput: vi.fn(),
        close: vi.fn(),
        async *[Symbol.asyncIterator]() {
          yield {
            type: stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives: [{ text: 'Turn 1.' }],
          };
        },
      };
      const provider = { stream: vi.fn(() => stream) } as unknown as microsoft.STT;
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const result = checkStt(
        provider,
        new Int16Array([1, 2, 3]),
        expected,
        new AbortController().signal,
      );
      if (succeeds) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow(/including its tail/);
      expect(stream.endInput).toHaveBeenCalledOnce();
      expect(stream.close).toHaveBeenCalledOnce();
      expect(output.mock.calls.flat().join(' ')).not.toContain(expected);
    },
  );

  it('synthesizes only the fixed sentence without printing it', async () => {
    const synthesize = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          frame: { sampleRate: 24_000, channels: 1, samplesPerChannel: 1001 },
          final: true,
        };
      },
      close: vi.fn(),
    }));
    const provider = { sampleRate: 24_000, synthesize } as unknown as microsoft.TTS;
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await checkTts(provider, new AbortController().signal);
    expect(synthesize).toHaveBeenCalledWith(TTS_TEXT, expect.any(Object), expect.any(AbortSignal));
    const printed = output.mock.calls.flat().join(' ');
    expect(printed).not.toContain(TTS_TEXT);
    expect(printed).toContain('PCM16 mono frames at 24000 Hz');
    expect(printed).toContain('not model TTFA');
  });
});
