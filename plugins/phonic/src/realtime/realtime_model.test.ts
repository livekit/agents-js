// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeModel, type RealtimeSession } from './realtime_model.js';

type SentConfig = { system_prompt?: string; tools?: Array<{ tool_schema?: { name?: string } }> };

const sentConfigs = vi.hoisted(() => [] as unknown[]);
const sentGenerateReplies = vi.hoisted(() => [] as unknown[]);
const messageHandlers = vi.hoisted(() => [] as Array<(message: unknown) => void>);

vi.mock('phonic', () => ({
  PhonicClient: class {
    conversations = {
      connect: async () => ({
        on: (event: string, handler: (message: unknown) => void) => {
          if (event === 'message') messageHandlers.push(handler);
        },
        waitForOpen: async () => {},
        sendConfig: (config: unknown) => sentConfigs.push(config),
        sendGenerateReply: (payload: unknown) => sentGenerateReplies.push(payload),
        close: () => {},
      }),
    };
  },
}));

const lookup = llm.tool({
  name: 'lookup',
  description: 'look something up',
  execute: async () => 'ok',
});

describe('Phonic initial session options', () => {
  let session: RealtimeSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    sentConfigs.length = 0;
  });

  it('sends the config from the seeded options', async () => {
    const chatCtx = llm.ChatContext.empty();
    chatCtx.addMessage({ role: 'user', content: 'hi there' });
    session = new RealtimeModel({ apiKey: 'test-key' }).session({
      instructions: 'be brief',
      chatCtx,
      tools: new llm.ToolContext([lookup]),
    });

    await vi.waitFor(() => expect(sentConfigs).toHaveLength(1));
    const config = sentConfigs[0] as SentConfig;
    expect(config.system_prompt).toContain('be brief');
    expect(config.system_prompt).toContain('hi there');
    expect(JSON.stringify(config.tools)).toContain('lookup');
  });

  it('does not wait for tools the seeded options leave out', async () => {
    session = new RealtimeModel({ apiKey: 'test-key' }).session({ instructions: 'be brief' });

    await vi.waitFor(() => expect(sentConfigs).toHaveLength(1));
    expect((sentConfigs[0] as SentConfig).system_prompt).toBe('be brief');
  });

  it('waits for instructions that the options leave out', async () => {
    session = new RealtimeModel({ apiKey: 'test-key' }).session({
      tools: new llm.ToolContext([lookup]),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sentConfigs).toHaveLength(0);

    await session.updateInstructions('be brief');
    await vi.waitFor(() => expect(sentConfigs).toHaveLength(1));
    expect(JSON.stringify((sentConfigs[0] as SentConfig).tools)).toContain('lookup');
  });

  it('keeps instructions per session', async () => {
    const model = new RealtimeModel({ apiKey: 'test-key' });
    const first = model.session({ instructions: 'first' });
    const second = model.session({ instructions: 'second' });
    // a session without instructions must not take another session's
    const third = model.session({ tools: new llm.ToolContext([lookup]) });
    try {
      await vi.waitFor(() => expect(sentConfigs).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const prompts = (sentConfigs as SentConfig[]).map((config) => config.system_prompt).sort();
      expect(prompts).toEqual(['first', 'second']);
      expect(model._options.instructions).toBeUndefined();
    } finally {
      await Promise.all([first.close(), second.close(), third.close()]);
    }
  });

  it('waits for the framework to configure a session created without options', async () => {
    session = new RealtimeModel({ apiKey: 'test-key' }).session();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sentConfigs).toHaveLength(0);

    await session._updateSession('be brief', llm.ChatContext.empty(), llm.ToolContext.empty());
    await vi.waitFor(() => expect(sentConfigs).toHaveLength(1));
  });
});

describe('Phonic modalities', () => {
  let session: RealtimeSession | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    sentConfigs.length = 0;
    sentGenerateReplies.length = 0;
    messageHandlers.length = 0;
  });

  const serverSends = (message: unknown) => {
    for (const handler of messageHandlers) handler(message);
  };

  it('sends the text modality as top-level config fields', async () => {
    const model = new RealtimeModel({
      apiKey: 'test-key',
      modalities: ['text'],
      additionalParams: { foo: 1 },
    });
    session = model.session({ instructions: 'be brief' });

    await vi.waitFor(() => expect(sentConfigs).toHaveLength(1));
    const config = sentConfigs[0] as Record<string, unknown>;
    expect(config.input_modality).toBe('text');
    expect(config.output_modality).toBe('text');
    expect(config.additional_params).toEqual({ foo: 1 });
    expect(model.capabilities.audioOutput).toBe(false);
    expect(model.capabilities.userTranscription).toBe(false);
  });

  it('sends no modality fields by default', async () => {
    const model = new RealtimeModel({ apiKey: 'test-key' });
    session = model.session({ instructions: 'be brief' });

    await vi.waitFor(() => expect(sentConfigs).toHaveLength(1));
    const config = sentConfigs[0] as Record<string, unknown>;
    expect(config).not.toHaveProperty('input_modality');
    expect(config).not.toHaveProperty('output_modality');
    expect(config.additional_params).toBeUndefined();
    expect(model.capabilities.audioOutput).toBe(true);
    expect(model.capabilities.userTranscription).toBe(true);
  });

  it('sends typed turns as user messages in text mode', async () => {
    session = new RealtimeModel({ apiKey: 'test-key', modalities: ['text'] }).session({
      instructions: 'be brief',
    });
    await vi.waitFor(() => expect(sentConfigs).toHaveLength(1));
    serverSends({ type: 'ready_to_start_conversation' });

    const chatCtx = llm.ChatContext.empty();
    chatCtx.addMessage({ role: 'user', content: 'What are your hours?' });
    await session.updateChatCtx(chatCtx);
    session.generateReply().catch(() => {});

    await vi.waitFor(() => expect(sentGenerateReplies).toHaveLength(1));
    expect(sentGenerateReplies[0]).toEqual({
      type: 'generate_reply',
      system_message: undefined,
      user_message: 'What are your hours?',
    });
  });

  it('ignores input_text in text mode', async () => {
    session = new RealtimeModel({ apiKey: 'test-key', modalities: ['text'] }).session({
      instructions: 'be brief',
    });
    await vi.waitFor(() => expect(sentConfigs).toHaveLength(1));
    const transcripts: unknown[] = [];
    session.on('input_audio_transcription_completed', (ev) => transcripts.push(ev));

    serverSends({ type: 'input_text', text: 'What are your hours?' });

    expect(transcripts).toHaveLength(0);
    expect(session.chatCtx.items).toHaveLength(0);
  });

  it('starts text-only generations in text mode', async () => {
    session = new RealtimeModel({ apiKey: 'test-key', modalities: ['text'] }).session({
      instructions: 'be brief',
    });
    await vi.waitFor(() => expect(sentConfigs).toHaveLength(1));
    const generations: llm.GenerationCreatedEvent[] = [];
    session.on('generation_created', (ev) => generations.push(ev));

    serverSends({ type: 'assistant_started_speaking' });

    expect(generations).toHaveLength(1);
    const { value: message } = await generations[0]!.messageStream.getReader().read();
    expect(await message!.modalities).toEqual(['text']);
    expect((await message!.audioStream.getReader().read()).done).toBe(true);
  });
});
