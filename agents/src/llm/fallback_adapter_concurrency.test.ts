// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { APIError, APIStatusError, APITimeoutError } from '../_exceptions.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Future } from '../utils.js';
import { ChatContext, FunctionCall } from './chat_context.js';
import { FallbackAdapter } from './fallback_adapter.js';
import { type ChatChunk, LLM, type LLMError, LLMStream } from './llm.js';

const noRetries: APIConnectOptions = { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 };
const textChunk: ChatChunk = {
  id: 'response',
  delta: { role: 'assistant', content: 'The answer.' },
};
const toolChunk: ChatChunk = {
  id: 'response',
  delta: {
    role: 'assistant',
    toolCalls: [new FunctionCall({ callId: 'transfer', name: 'transfer_call', args: '{}' })],
  },
};

class ControlledLLM extends LLM {
  readonly streams: ControlledStream[] = [];
  readonly errors: LLMError[] = [];

  constructor(readonly generate: (stream: ControlledStream, request: number) => Promise<void>) {
    super();
    this.on('error', (event) => this.errors.push(event));
  }

  label(): string {
    return 'controlled';
  }

  chat(opts: Parameters<LLM['chat']>[0]): ControlledStream {
    const stream = new ControlledStream(
      this,
      { ...opts, connOptions: opts.connOptions ?? noRetries },
      this.streams.length + 1,
    );
    this.streams.push(stream);
    return stream;
  }
}

class ControlledStream extends LLMStream {
  constructor(
    private readonly provider: ControlledLLM,
    opts: ConstructorParameters<typeof LLMStream>[1],
    private readonly request: number,
  ) {
    super(provider, opts);
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  send(chunk: ChatChunk = textChunk): void {
    this.queue.put(chunk);
  }

  protected run(): Promise<void> {
    return this.provider.generate(this, this.request);
  }
}

function observeErrors(adapter: FallbackAdapter): LLMError[] {
  const errors: LLMError[] = [];
  adapter.on('error', (event) => errors.push(event));
  return errors;
}

async function collect(stream: LLMStream): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  try {
    for await (const chunk of stream) chunks.push(chunk);
  } finally {
    stream.close();
  }
  return chunks;
}

async function waitForRecovery(adapter: FallbackAdapter): Promise<void> {
  await Promise.all(adapter._status.map((status) => status.recoveringTask));
}

describe('FallbackAdapter stream isolation', () => {
  it('does not attribute another stream error to a healthy foreground request', async () => {
    const releaseEarlier = new Future();
    const earlierError = new APITimeoutError({ message: 'Earlier request failed' });
    const provider = new ControlledLLM(async (stream, request) => {
      if (request === 1) {
        await releaseEarlier.await;
        throw earlierError;
      }
      stream.send();
      releaseEarlier.resolve();
      await earlierDone;
    });
    const earlierDone = collect(provider.chat({ chatCtx: new ChatContext() }));
    const adapter = new FallbackAdapter({ llms: [provider] });
    const errors = observeErrors(adapter);
    const chunks = await collect(
      adapter.chat({ chatCtx: new ChatContext(), connOptions: DEFAULT_API_CONNECT_OPTIONS }),
    );
    await earlierDone;
    await waitForRecovery(adapter);

    expect(chunks).toEqual([textChunk]);
    expect(errors).toEqual([]);
    expect(provider.errors.map((event) => event.error)).toEqual([earlierError]);
    expect(provider.streams).toHaveLength(2);
    expect(provider.listenerCount('error')).toBe(1);
  });

  it.each([true, false])(
    'accepts a successful child retry (provider listener=%s)',
    async (hasListener) => {
      let attempts = 0;
      const provider = new ControlledLLM(async (stream) => {
        if (++attempts === 1) throw new APITimeoutError({});
        stream.send();
      });
      if (!hasListener) provider.removeAllListeners('error');
      const adapter = new FallbackAdapter({ llms: [provider], maxRetryPerLLM: 1 });
      const errors = observeErrors(adapter);
      const chunks = await collect(adapter.chat({ chatCtx: new ChatContext() }));
      await waitForRecovery(adapter);

      expect(chunks).toEqual([textChunk]);
      expect(errors).toEqual([]);
      expect(provider.errors).toEqual(
        hasListener ? [expect.objectContaining({ recoverable: true })] : [],
      );
      expect(provider.streams).toHaveLength(1);
      expect(attempts).toBe(2);
    },
  );

  it('isolates errors from an overlapping background recovery request', async () => {
    const recoveryStarted = new Future();
    const releaseRecovery = new Future();
    const provider = new ControlledLLM(async (stream, request) => {
      if (request === 1) throw new APITimeoutError({ message: 'Initial failure' });
      if (request === 2) {
        recoveryStarted.resolve();
        await releaseRecovery.await;
        throw new APITimeoutError({ message: 'Recovery failure' });
      }
      stream.send();
      if (request === 3) {
        releaseRecovery.resolve();
        await recoveryDone;
      }
    });
    const adapter = new FallbackAdapter({ llms: [provider] });
    const errors = observeErrors(adapter);
    await collect(adapter.chat({ chatCtx: new ChatContext() }));
    await recoveryStarted.await;
    const recoveryDone = adapter._status[0]!.recoveringTask;
    errors.length = 0;

    const chunks = await collect(
      adapter.chat({ chatCtx: new ChatContext(), connOptions: DEFAULT_API_CONNECT_OPTIONS }),
    );
    await waitForRecovery(adapter);

    expect(chunks).toEqual([textChunk]);
    expect(errors).toEqual([]);
    expect(provider.streams).toHaveLength(3);
  });
});

describe('FallbackAdapter retries after output', () => {
  it.each<[string, ChatChunk]>([
    ['text', textChunk],
    ['tool calls', toolChunk],
    [
      'tool arguments without a name',
      {
        id: 'response',
        delta: {
          role: 'assistant',
          toolCalls: [new FunctionCall({ callId: 'transfer', name: '', args: '{}' })],
        },
      },
    ],
  ])('does not replay %s through the outer retry loop', async (_, chunk) => {
    const error = new APITimeoutError({ message: 'Failed after output' });
    const provider = new ControlledLLM(async (stream, request) => {
      stream.send(chunk);
      if (request === 1) throw error;
    });
    const adapter = new FallbackAdapter({ llms: [provider], retryOnChunkSent: false });
    const errors = observeErrors(adapter);
    const connOptions = { ...DEFAULT_API_CONNECT_OPTIONS };
    const stream = adapter.chat({ chatCtx: new ChatContext(), connOptions });
    const chunks = await collect(stream);
    await waitForRecovery(adapter);

    expect(chunks).toEqual([chunk]);
    expect(errors).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ cause: error, retryable: false, message: error.message }),
        recoverable: false,
      }),
    ]);
    expect(errors[0]!.error).toBeInstanceOf(APIError);
    expect(error.retryable).toBe(true);
    expect(provider.streams).toHaveLength(2); // Foreground and background recovery.
    expect(connOptions).toEqual(DEFAULT_API_CONNECT_OPTIONS);
    expect(stream.connOptions).toBe(connOptions);
  });

  it('preserves provider error details when output fails on a later outer attempt', async () => {
    const error = new APIStatusError({
      message: 'Provider unavailable',
      options: { statusCode: 503, requestId: 'request-1', body: { detail: 'overloaded' } },
    });
    const provider = new ControlledLLM(async (stream, request) => {
      if (request === 1) throw new APITimeoutError({});
      if (request === 2) return; // Recovery after the first failure.
      stream.send();
      if (request === 3) throw error;
    });
    const adapter = new FallbackAdapter({ llms: [provider] });
    const errors = observeErrors(adapter);
    const connOptions = { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 1, retryIntervalMs: 0 };
    const stream = adapter.chat({ chatCtx: new ChatContext(), connOptions });
    const chunks = await collect(stream);
    await waitForRecovery(adapter);

    expect(chunks).toEqual([textChunk]);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.recoverable).toBe(true);
    expect(errors[1]).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          cause: error,
          body: error.body,
          message: error.message,
          retryable: false,
        }),
        recoverable: false,
      }),
    );
    expect(error.retryable).toBe(true);
    expect(provider.streams).toHaveLength(4);
    expect(stream.connOptions).toBe(connOptions);
    expect(connOptions.maxRetry).toBe(1);
  });

  it.each([
    new APITimeoutError({ options: { retryable: false } }),
    new Error('Unexpected provider failure'),
  ])('preserves an already terminal error: %s', async (error) => {
    const provider = new ControlledLLM(async (stream, request) => {
      stream.send();
      if (request === 1) throw error;
    });
    const adapter = new FallbackAdapter({ llms: [provider] });
    const errors = observeErrors(adapter);
    const chunks = await collect(
      adapter.chat({ chatCtx: new ChatContext(), connOptions: DEFAULT_API_CONNECT_OPTIONS }),
    );
    await waitForRecovery(adapter);

    expect(chunks).toEqual([textChunk]);
    expect(errors).toEqual([expect.objectContaining({ error, recoverable: false })]);
    expect(provider.streams).toHaveLength(2);
  });

  it('still falls back after a metadata-only chunk', async () => {
    const metadata: ChatChunk = {
      id: 'metadata',
      delta: { role: 'assistant', extra: { signature: 'test' } },
    };
    const primary = new ControlledLLM(async (stream) => {
      stream.send(metadata);
      throw new APITimeoutError({});
    });
    const secondary = new ControlledLLM(async (stream) => {
      stream.send();
    });
    const adapter = new FallbackAdapter({ llms: [primary, secondary] });
    const errors = observeErrors(adapter);
    const chunks = await collect(
      adapter.chat({ chatCtx: new ChatContext(), connOptions: DEFAULT_API_CONNECT_OPTIONS }),
    );
    await waitForRecovery(adapter);

    expect(chunks).toEqual([metadata, textChunk]);
    expect(errors).toEqual([]);
  });

  it('preserves explicit retryOnChunkSent=true', async () => {
    const provider = new ControlledLLM(async (stream, request) => {
      stream.send();
      if (request === 1) throw new APITimeoutError({});
    });
    const adapter = new FallbackAdapter({ llms: [provider], retryOnChunkSent: true });
    observeErrors(adapter);
    const chunks = await collect(
      adapter.chat({ chatCtx: new ChatContext(), connOptions: DEFAULT_API_CONNECT_OPTIONS }),
    );
    await waitForRecovery(adapter);

    expect(chunks).toEqual([textChunk, textChunk]);
  });
});

describe('FallbackAdapter cancellation', () => {
  it('cancels a child waiting to retry without starting recovery', async () => {
    const retrying = new Future();
    let attempts = 0;
    const provider = new ControlledLLM(async () => {
      attempts++;
      throw new APITimeoutError({});
    });
    provider.once('error', () => retrying.resolve());
    const adapter = new FallbackAdapter({ llms: [provider], maxRetryPerLLM: 1 });
    const errors = observeErrors(adapter);
    const childFinished = new Future();
    provider.once('metrics_collected', () => childFinished.resolve());
    const stream = adapter.chat({
      chatCtx: new ChatContext(),
      connOptions: DEFAULT_API_CONNECT_OPTIONS,
    });
    const consumed = collect(stream);
    await retrying.await;
    stream.close();
    await consumed;
    await childFinished.await;
    await waitForRecovery(adapter);

    expect(attempts).toBe(1);
    expect(provider.streams).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(adapter._status[0]!.available).toBe(true);
  });

  it.each([false, true])('cancels the active child (output sent=%s)', async (sendOutput) => {
    const started = new Future();
    const release = new Future();
    const provider = new ControlledLLM(async (stream, request) => {
      if (request > 1) return;
      if (sendOutput) stream.send();
      started.resolve();
      await release.await;
      throw new APITimeoutError({});
    });
    const adapter = new FallbackAdapter({ llms: [provider] });
    const errors = observeErrors(adapter);
    const stream = adapter.chat({
      chatCtx: new ChatContext(),
      connOptions: DEFAULT_API_CONNECT_OPTIONS,
    });
    await started.await;
    if (sendOutput) await stream.next();
    stream.close();
    const childCancelled = provider.streams[0]!.signal.aborted;
    // Drain late provider completion before checking for erroneous recovery/retries.
    const finished = new Future();
    adapter.on('metrics_collected', (metrics) => {
      if (metrics.label === adapter.label()) finished.resolve();
    });
    release.resolve();
    await finished.await;
    await waitForRecovery(adapter);

    expect(childCancelled).toBe(true);
    expect(errors).toEqual([]);
    expect(provider.streams).toHaveLength(1);
    expect(adapter._status[0]!.available).toBe(true);
  });

  it('does not start a provider when closed immediately', async () => {
    const provider = new ControlledLLM(async () => {});
    const adapter = new FallbackAdapter({ llms: [provider] });
    const finished = new Future();
    adapter.on('metrics_collected', (metrics) => {
      if (metrics.label === adapter.label()) finished.resolve();
    });
    const stream = adapter.chat({ chatCtx: new ChatContext() });
    stream.close();
    await finished.await;

    expect(provider.streams).toHaveLength(0);
  });
});
