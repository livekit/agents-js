// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { type ChunkedStream, FallbackAdapter, SynthesizeStream, TTS } from '../tts/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Future } from '../utils.js';
import { Agent, AgentTask } from './agent.js';
import { AgentSession } from './agent_session.js';
import { isFrameworkOwned, markFrameworkOwned } from './model_ownership.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

class FakeSynthesizeStream extends SynthesizeStream {
  label = 'fake-tts-stream';
  protected async run(): Promise<void> {}
}

/** Counts the framework's prewarm and release calls. */
class PooledTTS extends TTS {
  label: string;
  released = 0;
  prewarmed = 0;
  constructor(label: string) {
    super(24000, 1, { streaming: true });
    this.label = label;
  }
  synthesize(): ChunkedStream {
    throw new Error('not implemented');
  }
  stream(options?: { connOptions?: APIConnectOptions }): SynthesizeStream {
    return new FakeSynthesizeStream(this, options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS);
  }
  override prewarm(): void {
    this.prewarmed++;
  }
  override async releaseIdleConnections(): Promise<void> {
    this.released++;
  }
}

/** A TTS the framework would have built from a model string. */
function ownedTTS(label: string): PooledTTS {
  return markFrameworkOwned(new PooledTTS(label));
}

async function settled(fn: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function handoff(session: AgentSession, from: Agent, to: Agent): Promise<void> {
  session.updateAgent(to);
  await settled(() => to._agentActivity !== undefined && from._agentActivity === undefined);
}

describe('framework-owned model marking', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('marks models built from a string and leaves user instances alone', () => {
    vi.stubEnv('LIVEKIT_API_KEY', 'key');
    vi.stubEnv('LIVEKIT_API_SECRET', 'secret');
    const fromString = Agent.create({ instructions: 'a', tts: 'cartesia/sonic-3' });
    const userTts = new PooledTTS('user');
    const fromInstance = Agent.create({ instructions: 'b', tts: userTts });

    expect(isFrameworkOwned(fromString.tts!)).toBe(true);
    expect(isFrameworkOwned(fromInstance.tts!)).toBe(false);
    expect(isFrameworkOwned(userTts)).toBe(false);
  });
});

describe('TTS connection release', () => {
  it('releases a framework-owned agent TTS on handoff and the session TTS only on close', async () => {
    const sessionTts = ownedTTS('session');
    const ttsA = ownedTTS('a');
    const ttsB = ownedTTS('b');
    const session = new AgentSession({ llm: new FakeLLM(), tts: sessionTts });
    const agentA = Agent.create({ instructions: 'a', tts: ttsA });
    const agentB = Agent.create({ instructions: 'b', tts: ttsB });
    const agentC = Agent.create({ instructions: 'c' }); // uses the session TTS
    onTestFinished(() => session.close());

    await session.start({ agent: agentA });
    await handoff(session, agentA, agentB);
    expect(ttsA.released).toBe(1);
    expect(ttsB.released).toBe(0);

    await handoff(session, agentB, agentC);
    expect(ttsB.released).toBe(1);
    expect(sessionTts.released).toBe(0);

    await session.close();
    expect(sessionTts.released).toBe(1);
    expect(ttsA.released).toBe(1);
    expect(ttsB.released).toBe(1);
  });

  it('never releases a user-constructed TTS, shared or not', async () => {
    const sessionTts = new PooledTTS('session');
    const shared = new PooledTTS('shared');
    const adapter = new FallbackAdapter({
      ttsInstances: [new PooledTTS('primary'), new PooledTTS('secondary')],
    });
    const session = new AgentSession({ llm: new FakeLLM(), tts: sessionTts });
    const agentA = Agent.create({ instructions: 'a', tts: shared });
    const agentB = Agent.create({ instructions: 'b', tts: shared });
    const agentC = Agent.create({ instructions: 'c', tts: adapter });
    onTestFinished(async () => {
      await session.close();
      await adapter.close();
    });

    await session.start({ agent: agentA });
    await handoff(session, agentA, agentB);
    await handoff(session, agentB, agentC);
    await session.close();

    expect(shared.released).toBe(0);
    expect(sessionTts.released).toBe(0);
    for (const child of adapter.ttsInstances as PooledTTS[]) {
      expect(child.released).toBe(0);
    }
  });

  it('releases a framework-owned TTS displaced by updateOptions', async () => {
    const owned = ownedTTS('owned');
    const replacement = ownedTTS('replacement');
    const user = new PooledTTS('user');
    const session = new AgentSession({ llm: new FakeLLM(), tts: new PooledTTS('session') });
    const agent = Agent.create({ instructions: 'a', tts: owned });
    onTestFinished(() => session.close());

    await session.start({ agent });
    await agent.updateOptions({ tts: replacement });
    expect(owned.released).toBe(1);
    expect(replacement.released).toBe(0);

    await agent.updateOptions({ tts: user });
    expect(replacement.released).toBe(1);

    await agent.updateOptions({ tts: ownedTTS('final') });
    expect(user.released).toBe(0);
  });

  it('releases a task TTS when the task completes, not the paused parent TTS', async () => {
    const parentTts = ownedTTS('parent');
    const taskTts = ownedTTS('task');
    const taskDone = new Future<void>();
    const task = AgentTask.create<string>({
      instructions: 'task',
      tts: taskTts,
      onEnter: () => task.complete('done'),
    });
    const agent = Agent.create({
      instructions: 'parent',
      tts: parentTts,
      tools: {
        transfer: tool({
          description: 'run the task',
          execute: async () => {
            const result = await task.run();
            taskDone.resolve();
            return result;
          },
        }),
      },
    });
    const llm = new FakeLLM([{ input: 'transfer', toolCalls: [{ name: 'transfer', args: {} }] }]);
    const session = new AgentSession({ llm, turnHandling: { turnDetection: 'manual' } });
    onTestFinished(() => session.close());

    await session.start({ agent });
    expect(parentTts.prewarmed).toBe(1);
    session.generateReply({ userInput: 'transfer', allowInterruptions: false });
    await taskDone.await;
    await settled(() => task._agentActivity === undefined && agent._agentActivity !== undefined);

    expect(taskTts.released).toBe(1);
    expect(parentTts.released).toBe(0);
    // the resumed parent warms its models again
    expect(parentTts.prewarmed).toBe(2);

    await session.close();
    expect(parentTts.released).toBe(1);
  });

  it('prewarms the TTS when an activity starts', async () => {
    const sessionTts = new PooledTTS('session');
    const ttsB = new PooledTTS('b');
    const session = new AgentSession({ llm: new FakeLLM(), tts: sessionTts });
    const agentA = Agent.create({ instructions: 'a' });
    const agentB = Agent.create({ instructions: 'b', tts: ttsB });
    onTestFinished(() => session.close());

    await session.start({ agent: agentA });
    expect(sessionTts.prewarmed).toBe(1);
    await handoff(session, agentA, agentB);
    expect(ttsB.prewarmed).toBe(1);
  });
});
