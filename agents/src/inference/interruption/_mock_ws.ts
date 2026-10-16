// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';

/**
 * Minimal stand-in for the `ws` WebSocket, used to drive the interruption transport in tests.
 *
 * Lives in its own module (rather than inline in each test) so the `vi.mock('ws')` factory can
 * `await import()` it without a top-level await — the tsup build transpiles test files to CJS,
 * which does not support top-level await.
 */
export class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  readyState = 0; // CONNECTING
  readonly sent: unknown[] = [];
  terminated = false;

  constructor(
    public url: string,
    public opts: unknown,
  ) {
    super();
    MockWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit('close', 1000, Buffer.from(''));
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  /** Simulate a successful upgrade. */
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open');
  }

  /** Simulate the server rejecting the upgrade with an HTTP status. */
  simulateUnexpectedResponse(statusCode: number): void {
    this.emit('unexpected-response', {}, { statusCode });
  }

  /** Simulate a server message frame carrying a JSON payload. */
  simulateMessage(payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }
}
