import { initializeLogger, llm } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { z } from 'zod';

initializeLogger({ pretty: false });

// Create a simple tool
const toolCtx: llm.ToolContext = {
  getWeather: llm.tool({
    description: 'Get the current weather in a given location',
    parameters: z.object({
      location: z.string().describe('The city and state, e.g. San Francisco, CA'),
      unit: z.enum(['celsius', 'fahrenheit']).describe('The temperature unit to use'),
    }),
    execute: async (params) => {
      return `The weather in ${params.location} is 22°${params.unit === 'celsius' ? 'C' : 'F'} and sunny.`;
    },
  }),
};

const googleModel = new google.LLM();
const chatCtx = llm.ChatContext.empty();

chatCtx.addMessage({
  role: 'user',
  content: 'Please call the getWeather function for San Francisco, CA in fahrenheit.',
});

const stream = googleModel.chat({
  chatCtx,
  toolCtx,
  toolChoice: 'required', // Force tool calling
});

console.log('Starting forced function calling test...');

for await (const chunk of stream) {
  console.log('Chunk:', JSON.stringify(chunk, null, 2));
}
