import { initializeLogger, llm } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';

initializeLogger({ pretty: false });

const oaiModel = new openai.LLM();
const chatCtx = llm.ChatContext.empty();

chatCtx.addMessage({
  role: 'user',
  content: 'Hello, how are you?',
});

const stream = oaiModel.chat({
  chatCtx,
});

for await (const chunk of stream) {
  console.log(chunk);
}
