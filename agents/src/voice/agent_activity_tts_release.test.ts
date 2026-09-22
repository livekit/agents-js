// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, onTestFinished } from 'vitest';
import { tool } from '../llm/tool_context.js';
import { initializeLogger } from '../log.js';
import { type ChunkedStream, SynthesizeStream, TTS } from '../tts/index.js';
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

/** Counts how often the framework asked it to drop pooled connections. */
class PooledTTS extends TTS {
  label: string;
  released = 0;
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
  override async releaseConnections(): Promise<void> {
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

describe('agent-owned TTS connection release', () => {
  it('releases an agent TTS on handoff to an agent with a different TTS, and the last one on close', async () => {
    const sessionTts = new PooledTTS('session');
    const ttsA = new PooledTTS('a');
    const ttsB = new PooledTTS('b');
    const session = new AgentSession({ llm: new FakeLLM(), tts: sessionTts });
    const agentA = Agent.create({ instructions: 'a', tts: ttsA });
    const agentB = Agent.create({ instructions: 'b', tts: ttsB });
    onTestFinished(() => session.close());

    await session.start({ agent: agentA });
    session.updateAgent(agentB);
    await settled(() => agentB._agentActivity !== undefined && agentA._agentActivity === undefined);

    expect(ttsA.released).toBe(1);
    expect(ttsB.released).toBe(0);
    expect(sessionTts.released).toBe(0);

    await session.close();
    expect(ttsB.released).toBe(1);
    expect(sessionTts.released).toBe(0);
  });

  it('keeps an agent TTS when the next agent uses the same instance', async () => {
    const shared = new PooledTTS('shared');
    const session = new AgentSession({ llm: new FakeLLM() });
    const agentA = Agent.create({ instructions: 'a', tts: shared });
    const agentB = Agent.create({ instructions: 'b', tts: shared });
    onTestFinished(() => session.close());

    await session.start({ agent: agentA });
    session.updateAgent(agentB);
    await settled(() => agentB._agentActivity !== undefined && agentA._agentActivity === undefined);
    expect(shared.released).toBe(0);

    await session.close();
    expect(shared.released).toBe(1);
  });

  it('never releases the session TTS', async () => {
    const sessionTts = new PooledTTS('session');
    const session = new AgentSession({ llm: new FakeLLM(), tts: sessionTts });
    const agentA = Agent.create({ instructions: 'a' });
    const agentB = Agent.create({ instructions: 'b' });
    onTestFinished(() => session.close());

    await session.start({ agent: agentA });
    session.updateAgent(agentB);
    await settled(() => agentB._agentActivity !== undefined && agentA._agentActivity === undefined);
    await session.close();

    expect(sessionTts.released).toBe(0);
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
    session.generateReply({ userInput: 'transfer', allowInterruptions: false });
    await taskDone.await;
    await settled(() => task._agentActivity === undefined && agent._agentActivity !== undefined);

    expect(taskTts.released).toBe(1);
    expect(parentTts.released).toBe(0);

    await session.close();
    expect(parentTts.released).toBe(1);
  });
});
