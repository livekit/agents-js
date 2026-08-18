// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { withResolvers } from '../utils.js';
import { ChatContext } from './chat_context.js';
import { type RealtimeCapabilities, RealtimeModel, type RealtimeSession } from './realtime.js';
import { RealtimeModelFallbackAdapter } from './realtime_fallback_adapter.js';

const capabilities: RealtimeCapabilities = {
  audioOutput: true,
  turnDetection: true,
  messageTruncation: true,
  userTranscription: true,
  manualFunctionCalls: true,
  autoToolReplyGeneration: true,
};

class FakeRealtimeSession extends EventEmitter {
  readonly chatCtx = ChatContext.empty();
  readonly closeEntered = withResolvers<void>();
  blockClose?: Promise<void>;

  async _updateSession(): Promise<void> {}

  async close(): Promise<void> {
    this.closeEntered.resolve();
    await this.blockClose;
  }
}

class FakeRealtimeModel extends RealtimeModel {
  activeSession!: FakeRealtimeSession;

  constructor() {
    super(capabilities);
  }

  get model(): string {
    return 'fake';
  }

  session(): RealtimeSession {
    this.activeSession = new FakeRealtimeSession();
    return this.activeSession as unknown as RealtimeSession;
  }

  async close(): Promise<void> {}
}

describe('RealtimeModelFallbackAdapter provider events', () => {
  it('preserves provider event subscribers across restart', async () => {
    const primary = new FakeRealtimeModel();
    const adapter = new RealtimeModelFallbackAdapter({ models: [primary] });
    const session = adapter.session();
    const received: unknown[] = [];
    session.on('provider_event', (event) => received.push(event));

    primary.activeSession.emit('provider_event', 'before-restart');
    await adapter.restartSession();
    primary.activeSession.emit('provider_event', 'after-restart');

    expect(received).toEqual(['before-restart', 'after-restart']);
    await session.close();
  });

  it('skips the old child when subscribed during restart', async () => {
    const primary = new FakeRealtimeModel();
    const adapter = new RealtimeModelFallbackAdapter({ models: [primary] });
    const session = adapter.session();
    const oldChild = primary.activeSession;
    const closeGate = withResolvers<void>();
    oldChild.blockClose = closeGate.promise;

    const restartTask = adapter.restartSession();
    await oldChild.closeEntered.promise;

    const received: unknown[] = [];
    session.on('provider_event', (event) => received.push(event));
    oldChild.emit('provider_event', 'old-child');

    closeGate.resolve();
    await restartTask;
    primary.activeSession.emit('provider_event', 'new-child');

    expect(received).toEqual(['new-child']);
    await session.close();
  });
});
