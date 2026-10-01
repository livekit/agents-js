// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIConnectionError } from '../_exceptions.js';
import { log } from '../log.js';
import { STT, type SpeechEvent, SpeechEventType, SpeechStream } from '../stt/stt.js';
import type { APIConnectOptions } from '../types.js';
import { Future } from '../utils.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes, CloseReason } from './events.js';

class ControlledSTT extends STT {
  label = 'controlled-stt';
  streams: ControlledStream[] = [];

  constructor() {
    super({ streaming: true, interimResults: true });
  }

  protected async _recognize(): Promise<SpeechEvent> {
    throw new Error('Use stream()');
  }

  stream(options?: { connOptions?: APIConnectOptions }): ControlledStream {
    const stream = new ControlledStream(this, undefined, options?.connOptions);
    this.streams.push(stream);
    return stream;
  }
}

class ControlledStream extends SpeechStream {
  label = 'controlled-stream';
  started = new Future<void>();
  failure = new Future<void>();

  emitTranscript() {
    this.queue.put({
      type: SpeechEventType.INTERIM_TRANSCRIPT,
      alternatives: [{ text: 'hello', startTime: 0, endTime: 0, confidence: 1 }],
    });
  }

  protected async run(): Promise<void> {
    this.started.resolve();
    if (this.abortSignal.aborted) return;
    const onAbort = () => this.failure.resolve();
    this.abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.failure.await;
    } finally {
      this.abortSignal.removeEventListener('abort', onAbort);
    }
  }
}

function createSession(stt: ControlledSTT, maxUnrecoverableErrors = 1) {
  return new AgentSession({
    stt,
    vad: null,
    connOptions: { sttConnOptions: { maxRetry: 0 }, maxUnrecoverableErrors },
    turnHandling: { turnDetection: 'stt', interruption: { enabled: false } },
  });
}

async function waitForStream(stt: ControlledSTT, index: number) {
  await vi.waitFor(() => expect(stt.streams).toHaveLength(index + 1));
  const stream = stt.streams[index]!;
  await stream.started.await;
  return stream;
}

afterEach(() => vi.restoreAllMocks());

describe('AgentSession STT recovery', () => {
  it.each(['none', 'observer', 'throwing'] as const)(
    'resumes transcripts after a provider failure with a %s error listener',
    async (listener) => {
      const stt = new ControlledSTT();
      const session = createSession(stt);
      const listenerError = new Error('error listener failed');
      const onError = vi.fn(() => {
        if (listener === 'throwing') throw listenerError;
      });
      if (listener !== 'none') session.on(AgentSessionEventTypes.Error, onError);
      const onClose = vi.fn();
      const onTranscript = vi.fn();
      session.on(AgentSessionEventTypes.Close, onClose);
      session.on(AgentSessionEventTypes.UserInputTranscribed, onTranscript);
      const errorLog = vi.spyOn(log(), 'error');

      try {
        await session.start({ agent: new Agent({ instructions: 'test' }) });
        const firstStream = await waitForStream(stt, 0);
        const providerError = new APIConnectionError({ message: 'connection dropped' });
        firstStream.failure.reject(providerError);

        const recoveredStream = await waitForStream(stt, 1);
        expect(firstStream.terminalError).toBe(providerError);
        recoveredStream.emitTranscript();
        await vi.waitFor(() =>
          expect(onTranscript).toHaveBeenCalledWith(
            expect.objectContaining({ transcript: 'hello', isFinal: false }),
          ),
        );
        expect(onClose).not.toHaveBeenCalled();
        if (listener !== 'none') {
          expect(onError).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              error: expect.objectContaining({ error: providerError, recoverable: false }),
              source: stt,
            }),
          );
        }
        if (listener === 'throwing') {
          expect(errorLog).toHaveBeenCalledWith(
            { err: listenerError },
            'Error in session error listener',
          );
        } else {
          expect(errorLog).not.toHaveBeenCalled();
        }
      } finally {
        await session.close();
      }
    },
  );

  it('closes after the STT recovery budget is exhausted without an error listener', async () => {
    const stt = new ControlledSTT();
    const session = createSession(stt);
    const onClose = vi.fn();
    session.on(AgentSessionEventTypes.Close, onClose);

    try {
      await session.start({ agent: new Agent({ instructions: 'test' }) });
      const firstStream = await waitForStream(stt, 0);
      firstStream.failure.reject(new APIConnectionError({ message: 'first failure' }));
      const secondStream = await waitForStream(stt, 1);
      const lastError = new APIConnectionError({ message: 'second failure' });
      secondStream.failure.reject(lastError);

      await vi.waitFor(() =>
        expect(onClose).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            reason: CloseReason.ERROR,
            error: expect.objectContaining({ error: lastError }),
          }),
        ),
      );
      expect(stt.streams).toHaveLength(2);
    } finally {
      await session.close();
    }
  });

  it.each([false, true])(
    'closes on a provider error the pipeline cannot retry (error listener: %s)',
    async (hasListener) => {
      const stt = new ControlledSTT();
      const session = createSession(stt);
      if (hasListener) session.on(AgentSessionEventTypes.Error, vi.fn());
      const onClose = vi.fn();
      session.on(AgentSessionEventTypes.Close, onClose);
      const errorLog = vi.spyOn(log(), 'error');
      const providerError = new Error('invalid provider response');

      try {
        await session.start({ agent: new Agent({ instructions: 'test' }) });
        const stream = await waitForStream(stt, 0);
        stream.failure.reject(providerError);

        await vi.waitFor(() =>
          expect(onClose).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              reason: CloseReason.ERROR,
              error: expect.objectContaining({ error: providerError }),
            }),
          ),
        );
        expect(stt.streams).toHaveLength(1);
        expect(errorLog).toHaveBeenCalledWith(
          expect.objectContaining({ error: providerError }),
          'AgentSession is closing due to an unrecoverable error',
        );
      } finally {
        await session.close();
      }
    },
  );

  it('stops the provider stream on shutdown without reporting an error', async () => {
    const stt = new ControlledSTT();
    const session = createSession(stt);
    const errorLog = vi.spyOn(log(), 'error');
    try {
      await session.start({ agent: new Agent({ instructions: 'test' }) });
      const stream = await waitForStream(stt, 0);
      await session.close();
      expect(stream.failure.done).toBe(true);
      expect(stream.terminalError).toBeUndefined();
      expect(stt.streams).toHaveLength(1);
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });
});
