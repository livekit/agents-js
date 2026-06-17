// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, voice } from '@livekit/agents';

const tools = {
  getWeather: llm.tool({
    description: 'Get the weather',
    execute: async () => 'sunny',
  }),
};

new voice.Agent({
  instructions: 'help',
  tools,
});

voice.Agent.create({
  instructions: 'help',
  tools,
});

new voice.AgentTask({
  instructions: 'help',
  tools,
});

voice.AgentTask.create({
  instructions: 'help',
  tools,
});

new voice.AgentSession({
  tools,
  vad: null,
});

const namedTool: llm.FunctionTool<Record<string, never>> = llm.tool({
  name: 'namedTool',
  description: 'Named tool',
  execute: async () => 'ok',
});

const anonymousTool: llm.AnonFunctionTool = llm.tool({
  description: 'Anonymous tool',
  execute: async () => 'ok',
});

new llm.ToolContext([namedTool]);
new llm.ToolContext({ anonymousTool });

// @ts-expect-error Toolsets are supported only in array syntax.
new llm.ToolContext({ grouped: llm.Toolset.create({ id: 'grouped', tools: [] }) });

// @ts-expect-error Object syntax requires anonymous function tools.
new llm.ToolContext({ namedTool });
