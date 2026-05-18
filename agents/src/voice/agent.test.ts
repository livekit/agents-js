// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ChatContext, ChatMessage, tool } from '../llm/index.js';
import { initializeLogger } from '../log.js';
import { Task } from '../utils.js';
import { Agent, AgentTask, _setActivityTaskInfo } from './agent.js';
import { AgentActivity, agentActivityStorage } from './agent_activity.js';
import { defaultEndpointingOptions } from './turn_config/endpointing.js';
import { defaultInterruptionOptions } from './turn_config/interruption.js';

vi.mock('ofetch', () => ({ ofetch: vi.fn() }));

initializeLogger({ pretty: false, level: 'error' });

async function collectReadableStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('Agent', () => {
  it('should create agent with basic instructions', () => {
    const instructions = 'You are a helpful assistant';
    const agent = new Agent({ instructions });

    expect(agent).toBeDefined();
    expect(agent.instructions).toBe(instructions);
  });

  it('should create agent with instructions and tools', () => {
    const instructions = 'You are a helpful assistant with tools';

    // Create mock tools using the tool function
    const mockTool1 = tool({
      name: 'getTool1',
      description: 'First test tool',
      parameters: z.object({}),
      execute: async () => 'tool1 result',
    });

    const mockTool2 = tool({
      name: 'getTool2',
      description: 'Second test tool',
      parameters: z.object({
        input: z.string().describe('Input parameter'),
      }),
      execute: async ({ input }) => `tool2: ${input}`,
    });

    const agent = new Agent({
      instructions,
      tools: [mockTool1, mockTool2],
    });

    expect(agent).toBeDefined();
    expect(agent.instructions).toBe(instructions);

    // Assert tools are set correctly
    const agentTools = agent.toolCtx.functionTools;
    expect(Object.keys(agentTools)).toHaveLength(2);
    expect(agentTools).toHaveProperty('getTool1');
    expect(agentTools).toHaveProperty('getTool2');

    // Verify tool properties with proper checks
    expect(agentTools.getTool1?.description).toBe('First test tool');
    expect(agentTools.getTool2?.description).toBe('Second test tool');
  });

  it('toolCtx returns a defensive copy that exposes the same tools', () => {
    const instructions = 'You are a helpful assistant';
    const mockTool = tool({
      name: 'testTool',
      description: 'Test tool',
      parameters: z.object({}),
      execute: async () => 'result',
    });

    const agent = new Agent({ instructions, tools: [mockTool] });

    // Each call returns a fresh ToolContext so external mutation can't escape into the agent's
    // internal state.
    expect(agent.toolCtx).not.toBe(agent.toolCtx);
    expect(agent.toolCtx.getFunctionTool('testTool')).toBe(mockTool);
  });

  describe('create', () => {
    it('preserves constructor options and base Agent default id', () => {
      const mockTool = tool({
        name: 'testTool',
        description: 'Test tool',
        parameters: z.object({}),
        execute: async () => 'result',
      });

      const agent = Agent.create({
        instructions: 'factory instructions',
        tools: [mockTool],
      });

      expect(agent).toBeInstanceOf(Agent);
      expect(agent.instructions).toBe('factory instructions');
      expect(agent.id).toBe('default_agent');
      expect(agent.toolCtx.getFunctionTool('testTool')).toBe(mockTool);
    });

    it('passes AgentContext to lifecycle hooks', async () => {
      const calls: string[] = [];
      const chatCtx = ChatContext.empty();
      const newMessage = ChatMessage.create({ role: 'user', content: ['hello'] });
      const agent = Agent.create({
        id: 'factory_agent',
        instructions: 'factory instructions',
        minConsecutiveSpeechDelay: 12,
        ttsPronunciationMap: { LiveKit: 'live kit' },
        onEnter: (ctx) => {
          expect(ctx.agent).toBe(agent);
          expect(ctx.id).toBe(agent.id);
          expect(ctx.instructions).toBe(agent.instructions);
          expect(ctx.toolCtx.functionTools).toEqual(agent.toolCtx.functionTools);
          expect(ctx.chatCtx.items).toEqual(agent.chatCtx.items);
          expect(ctx.minConsecutiveSpeechDelay).toBe(agent.minConsecutiveSpeechDelay);
          expect(ctx.ttsPronunciationMap).toBe(agent.ttsPronunciationMap);
          calls.push('enter');
        },
        onExit: async (ctx) => {
          expect(ctx.agent).toBe(agent);
          calls.push('exit');
        },
        onUserTurnCompleted: (ctx, receivedChatCtx, receivedMessage) => {
          expect(ctx.agent).toBe(agent);
          expect(receivedChatCtx).toBe(chatCtx);
          expect(receivedMessage).toBe(newMessage);
          calls.push('turn');
        },
      });

      await agent.onEnter();
      await agent.onExit();
      await agent.onUserTurnCompleted(chatCtx, newMessage);

      expect(calls).toEqual(['enter', 'exit', 'turn']);
    });

    it('adapts stream node hooks between ReadableStream and AsyncIterable', async () => {
      const audioFrame = 'audio' as unknown as AudioFrame;
      const agent = Agent.create({
        instructions: 'factory instructions',
        async sttNode(ctx, audio) {
          async function* stream() {
            expect(ctx.agent).toBe(agent);
            const frames: AudioFrame[] = [];
            for await (const frame of audio) {
              frames.push(frame);
            }
            expect(frames).toEqual([audioFrame]);
            yield 'transcript';
          }

          return stream();
        },
      });
      const audio = new ReadableStream<AudioFrame>({
        start(controller) {
          controller.enqueue(audioFrame);
          controller.close();
        },
      });

      const result = await agent.sttNode(audio, {});

      expect(result).not.toBeNull();
      await expect(collectReadableStream(result!)).resolves.toEqual(['transcript']);
    });

    it('falls back to existing defaults for missing hooks', async () => {
      const audioFrame = 'audio' as unknown as AudioFrame;
      const audio = new ReadableStream<AudioFrame>({
        start(controller) {
          controller.enqueue(audioFrame);
          controller.close();
        },
      });
      const agent = Agent.create({ instructions: 'factory instructions' });

      const result = await agent.realtimeAudioOutputNode(audio, {});

      expect(result).toBe(audio);
    });
  });

  it('should require AgentTask to run inside task context', async () => {
    class TestTask extends AgentTask<string> {
      constructor() {
        super({ instructions: 'test task' });
      }
    }

    const task = new TestTask();
    await expect(task.run()).rejects.toThrow('must be executed inside a Task context');
  });

  it('should require AgentTask to run inside inline task context', async () => {
    class TestTask extends AgentTask<string> {
      constructor() {
        super({ instructions: 'test task' });
      }
    }

    const task = new TestTask();
    const wrapper = Task.from(async () => {
      return await task.run();
    });

    await expect(wrapper.result).rejects.toThrow(
      'should only be awaited inside function tools or the onEnter/onExit methods of an Agent',
    );
  });

  it('should allow AgentTask run from inline task context', async () => {
    class TestTask extends AgentTask<string> {
      constructor() {
        super({ instructions: 'test task' });
      }
    }

    const task = new TestTask();
    const oldAgent = new Agent({ instructions: 'old agent' });
    const mockSession = {
      currentAgent: oldAgent,
      _globalRunState: undefined,
      _updateActivity: async (agent: Agent) => {
        if (agent === task) {
          task.complete('ok');
        }
      },
    };

    const mockActivity = {
      agent: oldAgent,
      agentSession: mockSession,
      _onEnterTask: undefined,
      llm: undefined,
      close: async () => {},
    };

    const wrapper = Task.from(async () => {
      const currentTask = Task.current();
      if (!currentTask) {
        throw new Error('expected task context');
      }
      _setActivityTaskInfo(currentTask, { inlineTask: true });
      return await agentActivityStorage.run(mockActivity as any, () => task.run());
    });

    await expect(wrapper.result).resolves.toBe('ok');
  });

  describe('AgentTask.create', () => {
    it('exposes complete on hook context', async () => {
      const task = AgentTask.create<string>({
        instructions: 'factory task',
        onEnter: (ctx) => {
          expect(ctx.agent).toBe(task);
          expect(ctx.id).toBe('default_agent');
          expect(ctx.instructions).toBe('factory task');
          ctx.complete('ok');
        },
      });
      const oldAgent = new Agent({ instructions: 'old agent' });
      const mockSession = {
        currentAgent: oldAgent,
        _globalRunState: undefined,
        _updateActivity: async (agent: Agent) => {
          if (agent === task) {
            await agent.onEnter();
          }
        },
      };
      const mockActivity = {
        agent: oldAgent,
        agentSession: mockSession,
        _onEnterTask: undefined,
        llm: undefined,
        close: async () => {},
      };

      const wrapper = Task.from(async () => {
        const currentTask = Task.current();
        if (!currentTask) {
          throw new Error('expected task context');
        }
        _setActivityTaskInfo(currentTask, { inlineTask: true });
        return await agentActivityStorage.run(mockActivity as any, () => task.run());
      });

      await expect(wrapper.result).resolves.toBe('ok');
    });

    it('adapts stream node hooks between ReadableStream and AsyncIterable', async () => {
      const audioFrame = 'audio' as unknown as AudioFrame;
      const task = AgentTask.create<string>({
        instructions: 'factory task',
        async sttNode(ctx, audio) {
          async function* stream() {
            expect(ctx.agent).toBe(task);
            const frames: AudioFrame[] = [];
            for await (const frame of audio) {
              frames.push(frame);
            }
            expect(frames).toEqual([audioFrame]);
            yield 'transcript';
          }

          return stream();
        },
      });
      const audio = new ReadableStream<AudioFrame>({
        start(controller) {
          controller.enqueue(audioFrame);
          controller.close();
        },
      });

      const result = await task.sttNode(audio, {});

      expect(result).not.toBeNull();
      await expect(collectReadableStream(result!)).resolves.toEqual(['transcript']);
    });

    it('falls back to existing defaults for missing hooks', async () => {
      const audioFrame = 'audio' as unknown as AudioFrame;
      const audio = new ReadableStream<AudioFrame>({
        start(controller) {
          controller.enqueue(audioFrame);
          controller.close();
        },
      });
      const task = AgentTask.create<string>({ instructions: 'factory task' });

      const result = await task.realtimeAudioOutputNode(audio, {});

      expect(result).toBe(audio);
    });
  });

  it('should require AgentTask to run inside AgentActivity context', async () => {
    class TestTask extends AgentTask<string> {
      constructor() {
        super({ instructions: 'test task' });
      }
    }

    const task = new TestTask();
    const wrapper = Task.from(async () => {
      const currentTask = Task.current();
      if (!currentTask) {
        throw new Error('expected task context');
      }
      _setActivityTaskInfo(currentTask, { inlineTask: true });
      return await task.run();
    });

    await expect(wrapper.result).rejects.toThrow(
      'must be executed inside an AgentActivity context',
    );
  });

  it('should close old activity when current agent changes while AgentTask is pending', async () => {
    class TestTask extends AgentTask<string> {
      constructor() {
        super({ instructions: 'test task' });
      }
    }

    const task = new TestTask();
    const oldAgent = new Agent({ instructions: 'old agent' });
    const switchedAgent = new Agent({ instructions: 'switched agent' });
    const closeOldActivity = vi.fn(async () => {});

    const mockSession = {
      currentAgent: oldAgent as Agent,
      _globalRunState: undefined,
      _updateActivity: async (agent: Agent) => {
        if (agent === task) {
          mockSession.currentAgent = switchedAgent;
          task.complete('ok');
        }
      },
    };

    const mockActivity = {
      agent: oldAgent,
      agentSession: mockSession,
      _onEnterTask: undefined,
      llm: undefined,
      close: closeOldActivity,
    };

    const wrapper = Task.from(async () => {
      const currentTask = Task.current();
      if (!currentTask) {
        throw new Error('expected task context');
      }
      _setActivityTaskInfo(currentTask, { inlineTask: true });
      return await agentActivityStorage.run(mockActivity as any, () => task.run());
    });

    await expect(wrapper.result).resolves.toBe('ok');
    expect(closeOldActivity).toHaveBeenCalledTimes(1);
  });

  describe('Agent constructor option migration', () => {
    it('should set allowInterruptions to false via deprecated constructor field', () => {
      const agent = new Agent({ instructions: 'test', allowInterruptions: false });
      expect(agent.turnHandling?.interruption?.enabled).toBe(false);
    });

    it('should not set derived properties when no compatibility fields are provided', () => {
      const agent = new Agent({ instructions: 'test' });
      expect(agent.turnHandling).toBeUndefined();
    });

    it('should expose minConsecutiveSpeechDelay', () => {
      const agent = new Agent({ instructions: 'test', minConsecutiveSpeechDelay: 1.5 });
      expect(agent.minConsecutiveSpeechDelay).toBe(1.5);
    });

    it('should ignore deprecated constructor fields when turnHandling is provided', () => {
      const agent = new Agent({
        instructions: 'test',
        turnHandling: {
          endpointing: { minDelay: 999 },
          interruption: {},
          preemptiveGeneration: {},
          turnDetection: 'vad',
        },
        allowInterruptions: false,
      });
      expect(agent.turnHandling?.endpointing?.minDelay).toBe(999);
      expect(agent.turnHandling?.endpointing?.maxDelay).toBeUndefined();
      expect(agent.turnHandling?.interruption?.enabled).toBeUndefined();
      expect(agent.turnHandling?.turnDetection).toBe('vad');
    });

    it('should let turnHandling override deprecated constructor fields on conflicts', () => {
      const agent = new Agent({
        instructions: 'test',
        turnHandling: {
          endpointing: { minDelay: 999, maxDelay: 4000 },
          interruption: { enabled: true },
          preemptiveGeneration: {},
          turnDetection: 'vad',
        },
        allowInterruptions: false,
        turnDetection: 'stt',
      });
      expect(agent.turnHandling?.endpointing?.minDelay).toBe(999);
      expect(agent.turnHandling?.endpointing?.maxDelay).toBe(4000);
      expect(agent.turnHandling?.interruption?.enabled).toBe(true);
      expect(agent.turnHandling?.turnDetection).toBe('vad');
    });

    it('should set interruptionDetection from turnHandling.interruption.mode', () => {
      const agent = new Agent({
        instructions: 'test',
        turnHandling: {
          interruption: { mode: 'adaptive' },
          endpointing: {},
          preemptiveGeneration: {},
          turnDetection: undefined,
        },
      });
      expect(agent.turnHandling?.interruption?.mode).toBe('adaptive');
    });

    it('should let AgentActivity prefer agent-level overrides over session defaults', () => {
      const agent = new Agent({
        instructions: 'test',
        turnHandling: {
          endpointing: { minDelay: 111, maxDelay: 222 },
          interruption: { enabled: false },
          preemptiveGeneration: {},
          turnDetection: 'manual',
        },
      });
      const session = {
        options: {
          turnHandling: {
            endpointing: defaultEndpointingOptions,
            interruption: defaultInterruptionOptions,
          },
        },
        turnDetection: 'stt',
        useTtsAlignedTranscript: true,
        vad: undefined,
        stt: undefined,
        llm: undefined,
        tts: undefined,
        interruptionDetection: undefined,
      } as any;

      const activity = new AgentActivity(agent as any, session);

      expect(activity.allowInterruptions).toBe(false);
      expect(activity.turnDetection).toBe('manual');
      expect(activity.turnHandling.endpointing?.minDelay).toBe(111);
      expect(activity.turnHandling.endpointing?.maxDelay).toBe(222);
    });

    it('should disable adaptive interruption detection in default mode when prerequisites are missing', () => {
      const previousRemoteEotUrl = process.env.LIVEKIT_REMOTE_EOT_URL;
      process.env.LIVEKIT_REMOTE_EOT_URL = 'http://localhost:9999';

      try {
        const agent = new Agent({ instructions: 'test' });
        const session = {
          options: {
            turnHandling: {
              endpointing: defaultEndpointingOptions,
              interruption: defaultInterruptionOptions,
            },
          },
          sessionOptions: {
            turnHandling: {
              endpointing: defaultEndpointingOptions,
              interruption: defaultInterruptionOptions,
            },
          },
          turnDetection: 'manual',
          useTtsAlignedTranscript: true,
          vad: {},
          stt: {
            capabilities: {
              alignedTranscript: true,
              streaming: true,
            },
          },
          llm: undefined,
          tts: undefined,
          interruptionDetection: undefined,
        } as any;

        const activity = new AgentActivity(agent as any, session);
        expect((activity as any).interruptionDetector).toBeUndefined();
      } finally {
        if (previousRemoteEotUrl === undefined) {
          delete process.env.LIVEKIT_REMOTE_EOT_URL;
        } else {
          process.env.LIVEKIT_REMOTE_EOT_URL = previousRemoteEotUrl;
        }
      }
    });

    it('should warn when session explicitly requests adaptive detection even if agent overrides it', () => {
      const activity = Object.create(AgentActivity.prototype) as any;
      activity.agent = {
        turnHandling: { interruption: { mode: 'vad' } },
        turnDetection: undefined,
      };
      activity.agentSession = {
        interruptionDetection: 'adaptive',
        turnDetection: 'manual',
      };
      activity.logger = { warn: vi.fn() };

      expect(activity.resolveInterruptionDetector()).toBeUndefined();
      expect(activity.logger.warn).toHaveBeenCalledWith(
        "interruptionDetection is provided, but it's not compatible with the current configuration and will be disabled",
      );
    });

    it('should disable adaptive interruption detection when interruptions are disabled', () => {
      const previousRemoteEotUrl = process.env.LIVEKIT_REMOTE_EOT_URL;
      process.env.LIVEKIT_REMOTE_EOT_URL = 'http://localhost:9999';

      try {
        const activity = Object.create(AgentActivity.prototype) as any;
        activity.agent = {
          turnHandling: {
            interruption: { enabled: false },
          },
          turnDetection: undefined,
          stt: undefined,
          vad: undefined,
          llm: undefined,
        };
        activity.agentSession = {
          interruptionDetection: undefined,
          turnDetection: 'stt',
          sessionOptions: {
            turnHandling: {
              interruption: defaultInterruptionOptions,
              endpointing: defaultEndpointingOptions,
            },
          },
          stt: {
            capabilities: {
              alignedTranscript: true,
              streaming: true,
            },
          },
          vad: {},
          llm: undefined,
        };
        activity.logger = { warn: vi.fn() };

        expect(activity.resolveInterruptionDetector()).toBeUndefined();
        expect(activity.logger.warn).not.toHaveBeenCalled();
      } finally {
        if (previousRemoteEotUrl === undefined) {
          delete process.env.LIVEKIT_REMOTE_EOT_URL;
        } else {
          process.env.LIVEKIT_REMOTE_EOT_URL = previousRemoteEotUrl;
        }
      }
    });
  });
});
