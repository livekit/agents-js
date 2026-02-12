// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChatMessage } from '../../llm/chat_context.js';
import { initializeLogger } from '../../log.js';
import { SpeechHandle } from '../speech_handle.js';
import { RunResult } from './run_result.js';

initializeLogger({ pretty: false, level: 'error' });

describe('RunResult', () => {
  it('removes speech item callback when unwatching a handle', () => {
    const result = new RunResult();
    const handle = SpeechHandle.create();

    result._watchHandle(handle);
    result._unwatchHandle(handle);

    const message = ChatMessage.create({
      role: 'assistant',
      content: 'hello',
    });
    handle._itemAdded([message]);

    expect(result.events).toHaveLength(0);

    // Done callback is removed too, so run should not complete automatically.
    handle._markDone();
    expect(result.done()).toBe(false);

    // Mirrors AgentTask.run() calling _markDoneIfNeeded() after unwatch.
    result._markDoneIfNeeded();
    expect(result.done()).toBe(true);
  });

  it('exposes finalOutput when output type matches', async () => {
    const result = new RunResult<string>({ outputType: z.string() });
    const handle = SpeechHandle.create();

    result._watchHandle(handle);
    handle._maybeRunFinalOutput = 'ok';
    handle._markDone();

    await result.wait();
    expect(result.finalOutput).toBe('ok');
  });

  it('rejects run when final output type mismatches expected outputType', async () => {
    const result = new RunResult<number>({ outputType: z.number() });
    const handle = SpeechHandle.create();

    result._watchHandle(handle);
    handle._maybeRunFinalOutput = 'not a number';
    handle._markDone();

    await expect(result.wait()).rejects.toThrow('Expected output matching provided zod schema');
  });

  it('rejects run when final output is an error', async () => {
    const result = new RunResult();
    const handle = SpeechHandle.create();

    result._watchHandle(handle);
    handle._maybeRunFinalOutput = new Error('boom');
    handle._markDone();

    await expect(result.wait()).rejects.toThrow('boom');
  });

  it('throws when accessing finalOutput before completion', () => {
    const result = new RunResult();
    expect(() => result.finalOutput).toThrow('cannot retrieve finalOutput, RunResult is not done');
  });
});
