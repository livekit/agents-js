// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, onTestFinished } from 'vitest';
import { tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { type ChunkedStream, FallbackAdapter, SynthesizeStream, TTS } from '../tts/index.js';
import { type APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS } from '../types.js';
import { Future } from '../utils.js';
import { Agent, AgentTask } from './agent.js';
import { AgentSession } from './agent_session.js';
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

describe('TTS connection release', () => {
  it('releases an agent TTS when its last user closes, and the session TTS only on close', async () => {
    const sessionTts = new PooledTTS('session');
    const ttsA = new PooledTTS('a');
    const ttsB = new PooledTTS('b');
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

  it('keeps an instance shared by two agents until both are done', async () => {
    const shared = new PooledTTS('shared');
    const session = new AgentSession({ llm: new FakeLLM(), tts: new PooledTTS('session') });
    const agentA = Agent.create({ instructions: 'a', tts: shared });
    const agentB = Agent.create({ instructions: 'b', tts: shared });
    const agentC = Agent.create({ instructions: 'c' });
    onTestFinished(() => session.close());

    await session.start({ agent: agentA });
    await handoff(session, agentA, agentB);
    expect(shared.released).toBe(0);

    await handoff(session, agentB, agentC);
    expect(shared.released).toBe(1);
  });

  it('keeps an instance shared by two sessions until the last one closes', async () => {
    const shared = new PooledTTS('shared');
    const first = new AgentSession({ llm: new FakeLLM(), tts: shared });
    const second = new AgentSession({ llm: new FakeLLM(), tts: shared });
    onTestFinished(async () => {
      await first.close();
      await second.close();
    });

    await first.start({ agent: Agent.create({ instructions: 'a' }) });
    await second.start({ agent: Agent.create({ instructions: 'b' }) });
    await first.close();
    expect(shared.released).toBe(0);

    await second.close();
    expect(shared.released).toBe(1);
  });

  it('releases every provider behind an agent-owned FallbackAdapter', async () => {
    const primary = new PooledTTS('primary');
    const secondary = new PooledTTS('secondary');
    const adapter = new FallbackAdapter({ ttsInstances: [primary, secondary] });
    const session = new AgentSession({ llm: new FakeLLM(), tts: new PooledTTS('session') });
    const agentA = Agent.create({ instructions: 'a', tts: adapter });
    const agentB = Agent.create({ instructions: 'b' });
    onTestFinished(async () => {
      await session.close();
      await adapter.close();
    });

    await session.start({ agent: agentA });
    await handoff(session, agentA, agentB);
    expect(primary.released).toBe(1);
    expect(secondary.released).toBe(1);
  });

  it('keeps a provider shared between a FallbackAdapter and a direct user until both are done', async () => {
    const cartesia = new PooledTTS('cartesia');
    const deepgram = new PooledTTS('deepgram');
    const adapter = new FallbackAdapter({ ttsInstances: [cartesia, deepgram] });
    const withAdapter = new AgentSession({ llm: new FakeLLM(), tts: adapter });
    const direct = new AgentSession({ llm: new FakeLLM(), tts: cartesia });
    onTestFinished(async () => {
      await withAdapter.close();
      await direct.close();
      await adapter.close();
    });

    await withAdapter.start({ agent: Agent.create({ instructions: 'a' }) });
    await direct.start({ agent: Agent.create({ instructions: 'b' }) });
    await withAdapter.close();
    expect(deepgram.released).toBe(1);
    expect(cartesia.released).toBe(0);

    await direct.close();
    expect(cartesia.released).toBe(1);
  });

  it('releases a TTS displaced by updateOptions', async () => {
    const first = new PooledTTS('first');
    const second = new PooledTTS('second');
    const sessionTts = new PooledTTS('session');
    const session = new AgentSession({ llm: new FakeLLM(), tts: sessionTts });
    const agent = Agent.create({ instructions: 'a', tts: first });
    onTestFinished(() => session.close());

    await session.start({ agent });
    await agent.updateOptions({ tts: second });
    expect(first.released).toBe(1);
    expect(second.released).toBe(0);

    // back to the session TTS: the session still uses it, so it stays warm
    await agent.updateOptions({ tts: sessionTts });
    expect(second.released).toBe(1);
    expect(sessionTts.released).toBe(0);

    await session.close();
    expect(sessionTts.released).toBe(1);
  });

  it('releases a task TTS when the task completes, not the paused parent TTS', async () => {
    const parentTts = new PooledTTS('parent');
    const taskTts = new PooledTTS('task');
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
