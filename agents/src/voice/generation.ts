import { randomUUID } from 'node:crypto';
import type { ReadableStream } from 'stream/web';
import type { ChatContext } from '../llm/chat_context.js';
import { IdentityTransform } from '../stream/identity_transform.js';
import type { LLMNode } from './io.js';

/* @internal */
export class _LLMGenerationData {
  generatedText: string = '';
  id: string;

  constructor(public readonly textStream: ReadableStream<string>) {
    // TODO(shubhra): standardize id generation - same as python
    this.id = randomUUID();
  }
}

export function performLLMInference(
  node: LLMNode,
  chatCtx: ChatContext,
  modelSettings: any, // TODO(shubhra): add type
): [() => Promise<void>, _LLMGenerationData] {
  const text_stream = new IdentityTransform<string>();
  const writer = text_stream.writable.getWriter();
  const text_output_stream = text_stream.readable;
  const data = new _LLMGenerationData(text_output_stream);

  const inferenceTask = async () => {
    const llmStream = await node(chatCtx, modelSettings);
    if (llmStream === null) {
      return;
    }
    try {
      for await (const chunk of llmStream) {
        if (typeof chunk === 'string') {
          data.generatedText += chunk;
          writer.write(chunk);
          // TODO(shubhra): better way to check??
        } else if ('choices' in chunk) {
          const content = chunk.choices[0]?.delta.content;
          if (!content) continue;
          data.generatedText += content;
          writer.write(content);
        } else {
          //TODO(shubhra): get access to logger instance
          console.error('Unexpected chunk type:', chunk);
        }
      }
    } finally {
      llmStream.cancel();
      writer.close();
      text_output_stream.cancel();
    }
  };
  return [inferenceTask, data];
}
