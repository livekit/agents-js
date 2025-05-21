import type { AudioFrame } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import type { ReadableStream } from 'stream/web';
import type { ChatContext } from '../llm/chat_context.js';
import { IdentityTransform } from '../stream/identity_transform.js';
import type { LLMNode, TTSNode } from './io.js';

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
): [Promise<void>, _LLMGenerationData] {
  const textStream = new IdentityTransform<string>();
  const writer = textStream.writable.getWriter();
  const data = new _LLMGenerationData(textStream.readable);

  const inferenceTask = async () => {
    const llmStream = await node(chatCtx, modelSettings);
    if (llmStream === null) {
      return;
    }
    try {
      const reader = llmStream.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) {
          console.log('+++++++++++++ LLM stream ended in performLLMInference');
          break;
        }
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
      console.log('+++++++++++++ Closing writer in performLLMInference');
      writer.close();
    }
  };
  return [inferenceTask(), data];
}

export async function performTTSInference(
  node: TTSNode,
  text: ReadableStream<string>,
  modelSettings: any, // TODO(shubhra): add type
): Promise<ReadableStream<AudioFrame>> {
  const audioStream = new IdentityTransform<AudioFrame>();
  const writer = audioStream.writable.getWriter();
  const audioOutputStream = audioStream.readable;

  try {
    const ttsNode = await node(text, modelSettings);
    if (ttsNode === null) {
      writer.close();
      return audioOutputStream;
    }

    const reader = ttsNode.getReader();
    while (true) {
      console.log('+++++++++++++ reading tts node');
      const { done, value: chunk } = await reader.read();
      if (done) break;
      writer.write(chunk);
    }
  } finally {
    console.log('+++++++++++++ closing writer in performTTSInference');
    writer.close();
  }

  return audioOutputStream;
}
