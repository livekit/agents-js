// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as agents from '@livekit/agents';
import type { llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type PhonicConversationEndedEvent,
  PhonicNoInputTimeoutError,
  RealtimeModel,
  type RealtimeSession,
} from './realtime_model.js';

const socketHandlers = vi.hoisted(() => new Map<string, (arg: unknown) => void>());
const shutdowns = vi.hoisted(() => [] as Array<{ drain?: boolean }>);

vi.mock('phonic', () => ({
  PhonicClient: class {
    conversations = {
      connect: async () => ({
        on: (event: string, handler: (arg: unknown) => void) => socketHandlers.set(event, handler),
        waitForOpen: async () => {},
        sendConfig: () => {},
        close: () => {},
      }),
    };
  },
}));

vi.mock('@livekit/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof agents>()),
  getJobContext: () => ({
    _primaryAgentSession: { shutdown: (options: { drain?: boolean }) => shutdowns.push(options) },
  }),
}));

describe('Phonic conversation end', () => {
  let session: RealtimeSession | undefined;
  let errors: llm.RealtimeModelError[];
  let ended: PhonicConversationEndedEvent[];

  async function startSession(): Promise<void> {
    session = new RealtimeModel({ apiKey: 'test-key' }).session({ instructions: 'be brief' });
    errors = [];
    ended = [];
    session.on('error', (error: llm.RealtimeModelError) => errors.push(error));
    session.on('phonic_conversation_ended', (event: PhonicConversationEndedEvent) =>
      ended.push(event),
    );
    await vi.waitFor(() => expect(socketHandlers.has('close')).toBe(true));
  }

  afterEach(async () => {
    await session?.close();
    session = undefined;
    socketHandlers.clear();
    shutdowns.length = 0;
  });

  it.each([
    [
      'assistant_ended_conversation',
      () => socketHandlers.get('message')!({ type: 'assistant_ended_conversation' }),
    ],
    ['time_limit_reached', () => socketHandlers.get('close')!({ code: 4505, reason: 'closed' })],
  ])('treats %s as a normal end that shuts down the agent session', async (reason, end) => {
    await startSession();
    end();

    expect(errors).toEqual([]);
    expect(ended).toEqual([{ reason }]);
    expect(shutdowns).toEqual([{ drain: true }]);
  });

  it('reports a no-input timeout as one typed unrecoverable error', async () => {
    await startSession();
    socketHandlers.get('close')!({ code: 4500, reason: 'Conversation became inactive' });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.recoverable).toBe(false);
    expect(errors[0]!.error).toBeInstanceOf(PhonicNoInputTimeoutError);
    expect(shutdowns).toEqual([]);
  });

  it('still reports other close codes as errors', async () => {
    await startSession();
    socketHandlers.get('close')!({ code: 4501, reason: 'error' });

    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).not.toBeInstanceOf(PhonicNoInputTimeoutError);
    expect(shutdowns).toEqual([]);
  });
});
