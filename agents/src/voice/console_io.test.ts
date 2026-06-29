// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AgentSession as pb } from '@livekit/protocol';
import { AudioFrame } from '@livekit/rtc-node';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import type { AgentSession } from './agent_session.js';
import { AgentsConsole, TcpAudioInput, TcpAudioOutput } from './console_io.js';
import { SessionHost, SessionTransport } from './remote_session.js';

beforeAll(() => {
  initializeLogger({ pretty: true, level: 'info' });
});

/** Captures outbound messages and lets a test push inbound ones. */
class FakeTransport extends SessionTransport {
  readonly sent: pb.AgentSessionMessage[] = [];
  private readonly inbound: pb.AgentSessionMessage[] = [];
  private waitingResolve: ((value: IteratorResult<pb.AgentSessionMessage>) => void) | null = null;
  private closed = false;

  push(msg: pb.AgentSessionMessage): void {
    if (this.waitingResolve) {
      const resolve = this.waitingResolve;
      this.waitingResolve = null;
      resolve({ value: msg, done: false });
    } else {
      this.inbound.push(msg);
    }
  }

  override async sendMessage(msg: pb.AgentSessionMessage): Promise<void> {
    this.sent.push(msg);
  }

  override async close(): Promise<void> {
    this.closed = true;
    if (this.waitingResolve) {
      const resolve = this.waitingResolve;
      this.waitingResolve = null;
      resolve({ value: undefined as unknown as pb.AgentSessionMessage, done: true });
    }
  }

  override [Symbol.asyncIterator](): AsyncIterator<pb.AgentSessionMessage> {
    return {
      next: () => {
        const pending = this.inbound.shift();
        if (pending) return Promise.resolve({ value: pending, done: false });
        if (this.closed) {
          return Promise.resolve({
            value: undefined as unknown as pb.AgentSessionMessage,
            done: true,
          });
        }
        return new Promise((resolve) => {
          this.waitingResolve = resolve;
        });
      },
    };
  }
}

function consoleFrame(
  sampleRate: number,
  samples: number,
): pb.AgentSessionMessage_ConsoleIO_AudioFrame {
  return new pb.AgentSessionMessage_ConsoleIO_AudioFrame({
    data: new Uint8Array(samples * 2),
    sampleRate,
    numChannels: 1,
    samplesPerChannel: samples,
  });
}

describe('TcpAudioInput', () => {
  it('resamples wire frames to the agent rate and exposes them on the stream', async () => {
    const input = new TcpAudioInput();
    const reader = input.stream.getReader();

    // 1s @ 48 kHz in -> 24 kHz out
    input.pushFrame(consoleFrame(48000, 48000));

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(value.sampleRate).toBe(24000);
    expect(value.channels).toBe(1);

    reader.releaseLock();
    await input.close();
  });

  it('drops frames pushed after close', async () => {
    const input = new TcpAudioInput();
    await input.close();
    expect(() => input.pushFrame(consoleFrame(48000, 48000))).not.toThrow();
  });
});

describe('TcpAudioOutput', () => {
  function agentFrame(seconds: number): AudioFrame {
    const samples = 24000 * seconds;
    return new AudioFrame(new Int16Array(samples), 24000, 1, samples);
  }

  it('streams resampled frames and completes the flush handshake on playout finished', async () => {
    const transport = new FakeTransport();
    const out = new TcpAudioOutput(transport);

    await out.captureFrame(agentFrame(1));
    out.flush();

    const playout = out.waitForPlayout();
    out.notifyPlayoutFinished();
    const ev = await playout;

    expect(ev.interrupted).toBe(false);
    expect(ev.playbackPosition).toBeCloseTo(1, 1);

    expect(transport.sent.some((m) => m.message.case === 'audioOutput')).toBe(true);
    expect(transport.sent.some((m) => m.message.case === 'audioPlaybackFlush')).toBe(true);
  });

  it('reports interruption when the buffer is cleared mid-playout', async () => {
    const transport = new FakeTransport();
    const out = new TcpAudioOutput(transport);

    await out.captureFrame(agentFrame(1));
    out.flush();

    const playout = out.waitForPlayout();
    out.clearBuffer();
    const ev = await playout;

    expect(ev.interrupted).toBe(true);
    expect(ev.playbackPosition).toBeLessThan(1);
    expect(transport.sent.some((m) => m.message.case === 'audioPlaybackClear')).toBe(true);
  });
});

describe('AgentsConsole', () => {
  afterEach(() => {
    AgentsConsole._reset();
  });

  const makeSession = () =>
    ({
      input: { audio: {} },
      output: { audio: {}, transcription: {} },
    }) as unknown as AgentSession;

  it('is a process-wide singleton', () => {
    expect(AgentsConsole.getInstance()).toBe(AgentsConsole.getInstance());
  });

  it('acquireIo attaches the audio bridges (voice default) and flips ioAcquired', () => {
    const c = AgentsConsole.getInstance();
    expect(c.ioAcquired).toBe(false);

    const audioInput = {} as unknown as TcpAudioInput;
    const audioOutput = {} as unknown as TcpAudioOutput;
    c.audioInput = audioInput;
    c.audioOutput = audioOutput;

    const session = makeSession();
    c.acquireIo(session);

    expect(c.ioAcquired).toBe(true);
    expect(session.input.audio).toBe(audioInput);
    expect(session.output.audio).toBe(audioOutput);
    expect(session.output.transcription).toBeNull();
  });

  it('throws when acquired by a second session', () => {
    const c = AgentsConsole.getInstance();
    c.acquireIo(makeSession());
    expect(() => c.acquireIo(makeSession())).toThrow(/already acquired/);
  });
});

describe('SessionHost audio routing', () => {
  it('routes audioInput to pushFrame and audioPlaybackFinished to notifyPlayoutFinished', async () => {
    const transport = new FakeTransport();
    const pushFrame = vi.fn();
    const notifyPlayoutFinished = vi.fn();
    const audioInput = { pushFrame } as unknown as TcpAudioInput;
    const audioOutput = { notifyPlayoutFinished } as unknown as TcpAudioOutput;

    const host = new SessionHost(transport, audioInput, audioOutput);
    await host.start();

    transport.push(
      new pb.AgentSessionMessage({
        message: { case: 'audioInput', value: consoleFrame(48000, 480) },
      }),
    );
    transport.push(
      new pb.AgentSessionMessage({
        message: {
          case: 'audioPlaybackFinished',
          value: new pb.AgentSessionMessage_ConsoleIO_AudioPlaybackFinished(),
        },
      }),
    );

    await vi.waitFor(() => {
      expect(pushFrame).toHaveBeenCalledTimes(1);
      expect(notifyPlayoutFinished).toHaveBeenCalledTimes(1);
    });

    await host.close();
  });
});
