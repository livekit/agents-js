import { ChatContext } from '../chat_context.js';

export function to_chat_ctx(chatCtx: ChatContext, injectDummyUserMessage: boolean = true) {
  return chatCtx.toProviderFormat('openai');
}
