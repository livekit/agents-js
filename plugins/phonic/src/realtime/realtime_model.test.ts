// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeModel, type RealtimeSession } from './realtime_model.js';

type SentConfig = { system_prompt?: string; tools?: Array<{ tool_schema?: { name?: string } }> };

const sentConfigs = vi.hoisted(() => [] as unknown[]);

vi.mock('phonic', () => ({
  PhonicClient: class {
    conversations = {
      connect: async () => ({
        on: () => {},
        waitForOpen: async () => {},
        sendConfig: (config: unknown) => sentConfigs.push(config),
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

  it('waits for the framework to configure a session created without options', async () => {
    session = new RealtimeModel({ apiKey: 'test-key' }).session();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sentConfigs).toHaveLength(0);

    await session._updateSession('be brief', llm.ChatContext.empty(), llm.ToolContext.empty());
    await vi.waitFor(() => expect(sentConfigs).toHaveLength(1));
  });
});
