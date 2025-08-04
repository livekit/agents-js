import { initializeLogger, llm } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';

initializeLogger({ pretty: false });

const googleModel = new google.LLM();
const chatCtx = llm.ChatContext.empty();

chatCtx.addMessage({
  role: 'user',
  content: 'Hello, how are you?',
});

const stream = googleModel.chat({
  chatCtx,
});

for await (const chunk of stream) {
  console.log(chunk);
}
