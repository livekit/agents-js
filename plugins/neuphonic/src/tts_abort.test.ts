// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sockets: FakeWebSocket[] = [];
let openDelayMs = 0;

// Stands in for the `ws` client: opens after `openDelayMs` and, like the real one, reports a close
// only after `close()` is called. Closing before it opened fails the handshake with an error.
class FakeWebSocket extends EventEmitter {
  sent: string[] = [];
  closeCalled = false;
  #opened = false;

  constructor() {
    super();
    sockets.push(this);
    setTimeout(() => {
      if (this.closeCalled) return;
      this.#opened = true;
      this.emit('open');
    }, openDelayMs);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCalled = true;
    setTimeout(() => {
      if (!this.#opened) {
        this.emit('error', new Error('WebSocket was closed before the connection was established'));
      }
      this.emit('close', 1000, Buffer.from(''));
    }, 0);
  }
}

vi.mock('ws', () => ({ WebSocket: FakeWebSocket }));

const { TTS } = await import('./tts.js');

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Neuphonic SynthesizeStream close', () => {
  beforeEach(() => {
    sockets.length = 0;
    openDelayMs = 0;
  });

  it('closes the WebSocket when the stream is closed mid-synthesis', async () => {
    const stream = new TTS({ apiKey: 'test-key' }).stream();

    stream.pushText('Hello there. ');
    stream.flush();
    await waitFor(() => sockets[0]?.sent.length === 1);

    stream.close();

    await waitFor(() => sockets[0]!.closeCalled);
    expect(sockets[0]!.closeCalled).toBe(true);
    // an interrupted synthesis must not ask the provider to finish the utterance
    expect(sockets[0]!.sent.some((message) => message.includes('<STOP>'))).toBe(false);
  });

  it('does not report an error when the stream is closed while connecting', async () => {
    openDelayMs = 200;
    const tts = new TTS({ apiKey: 'test-key' });
    const onError = vi.fn();
    tts.on('error', onError);
    const stream = tts.stream();

    await waitFor(() => sockets.length === 1);
    // closes before the socket's open event
    stream.close();

    await waitFor(() => sockets[0]!.closeCalled);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onError).not.toHaveBeenCalled();
  });
});
