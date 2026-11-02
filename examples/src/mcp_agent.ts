// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  voice,
} from '@livekit/agents';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        'You are the LiveKit documentation QA assistant. Use the LiveKit Docs MCP tools to ' +
        'answer questions about LiveKit accurately. The interface is voice-based: accept spoken ' +
        'user queries and respond with synthesized speech.',
    });

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'multi' }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      turnHandling: {
        turnDetection: new inference.TurnDetector(),
      },
      tools: [
        new llm.MCPToolset({
          id: 'livekit_docs',
          mcpServer: new llm.MCPServerHTTP({
            url: 'https://docs.livekit.io/mcp/',
            transportType: 'streamable_http',
          }),
        }),
      ],
    });

    await session.start({ agent, room: ctx.room });

    session.generateReply({ instructions: 'greet the user and introduce yourself' });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
