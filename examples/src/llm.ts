// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, llm } from '@livekit/agents';
import { LLM } from '@livekit/agents-plugin-openai';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log('starting STT example agent');

    const initialContent = new llm.ChatContext()
      .append({
        role: llm.ChatRole.SYSTEM,
        text: 'You are a weather assistant created by LiveKit. Your interface with users will be voice. You will provide weather information for a given location.',
      })
      .append({
        role: llm.ChatRole.USER,
        text: "What's the weather in San Francisco?",
      });

    const fncCtx: llm.FunctionContext = {
      weather: {
        description: 'Get the weather in a location',
        parameters: z.object({
          location: z.string().describe('The location to get the weather for'),
        }),
        execute: async ({ location }) => {
          console.debug(`executing weather function for ${location}`);
          const response = await fetch(`https://wttr.in/${location}?format=%C+%t`);
          if (!response.ok) {
            throw new Error(`Weather API returned status: ${response.status}`);
          }
          const weather = await response.text();
          return `The weather in ${location} right now is ${weather}.`;
        },
      },
    };

    const ollm = new LLM();
    let stream = ollm.chat({ chatCtx: initialContent, fncCtx });
    for await (const _ of stream) {
      continue;
    }

    // TODO(nbsp): the stream awaitable needs to be awaited before functions are executed
    // await new Promise((resolve) => setTimeout(resolve, 2000))
    const functions = stream.executeFunctions();
    let toolCallsInfo = [];
    let toolCallsResults = [];
    for (const func of functions) {
      if (func.task) {
        const task = await func.task;
        toolCallsInfo.push(func);
        toolCallsResults.push(llm.ChatMessage.createToolFromFunctionResult(task));
      }
    }
    const chatCtx = initialContent.copy();
    chatCtx.messages.push(llm.ChatMessage.createToolCalls(toolCallsInfo));
    chatCtx.messages.push(...toolCallsResults);

    stream = ollm.chat({ chatCtx, fncCtx });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
