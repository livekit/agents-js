// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { beforeAll, expect, it } from 'vitest';
import { initializeLogger } from '../../log.js';
import { Future } from '../../utils.js';
import { Agent } from '../agent.js';
import { AgentSession } from '../agent_session.js';
import { TextOutput } from '../io.js';
import { FakeLLM } from './fake_llm.js';
import type { RunResult } from './run_result.js';

beforeAll(() => initializeLogger({ pretty: false, level: 'warn' }));

it.each(['run', 'cancel'] as const)(
  'retains run ownership when output cancellation re-enters %s',
  async (action) => {
    const captured = new Future<void>();
    const release = new Future<void>();
    let run: RunResult | undefined;
    let reentrantRun: RunResult | undefined;
    let reentrantCancellation: Promise<void> | undefined;
    let cancellation: Promise<void> | undefined;
    let admissionError: unknown;
    let cancelled = false;

    class Sink extends TextOutput {
      override async captureText() {
        captured.resolve();
      }
      override flush() {}
    }

    class TestAgent extends Agent {
      override async transcriptionNode(input: Parameters<Agent['transcriptionNode']>[0]) {
        if (cancelled) return input;
        return new ReadableStream<string>({
          start(controller) {
            controller.enqueue('old prefix');
          },
          cancel() {
            cancelled = true;
            if (action === 'run') {
              try {
                reentrantRun = session.run({ userInput: 'fresh' });
              } catch (error) {
                admissionError = error;
              }
            } else {
              reentrantCancellation = run!._cancel();
            }
            return release.await;
          },
        });
      }
    }

    const session = new AgentSession({
      llm: new FakeLLM([
        { input: 'go', content: 'old' },
        { input: 'fresh', content: 'new reply' },
      ]),
    });
    session.output.transcription = new Sink();
    try {
      await session.start({ agent: new TestAgent({ instructions: 'test' }) });
      run = session.run({ userInput: 'go' });
      void run.wait().catch(() => {});
      await captured.await;
      cancellation = run._cancel();
      let settled = false;
      void cancellation.then(() => (settled = true));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(cancelled).toBe(true);
      expect(settled).toBe(false);
      expect(session._globalRunState === run).toBe(true);
      expect(run._cancel()).toBe(cancellation);
      expect(() => session.run({ userInput: 'fresh' })).toThrow('nested runs');
      if (action === 'run') {
        expect(admissionError).toBeInstanceOf(Error);
        expect((admissionError as Error).message).toContain('nested runs');
        expect(reentrantRun).toBeUndefined();
      } else {
        expect(reentrantCancellation).toBe(cancellation);
      }

      release.resolve();
      await cancellation;
      const fresh = session.run({ userInput: 'fresh' });
      await fresh.wait();
      fresh.expect.nextEvent().isMessage({ role: 'assistant', textContent: 'new reply' });
      fresh.expect.noMoreEvents();
    } finally {
      release.resolve();
      await cancellation;
      await reentrantCancellation;
      await reentrantRun?.wait();
      await session.close();
    }
  },
);
