// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { PreTrainedTokenizer } from '@huggingface/transformers';
import { AutoTokenizer } from '@huggingface/transformers';
import type { ipc, llm } from '@livekit/agents';
import { CurrentJobContext, InferenceRunner, log } from '@livekit/agents';
import { fileURLToPath } from 'node:url';
import { InferenceSession, Tensor } from 'onnxruntime-node';

const MAX_HISTORY_TURNS = 6;

type RawChatContext = { role: string; content: string }[];

export class EOURunner extends InferenceRunner {
  static INFERENCE_METHOD = 'lk_end_of_utterance';
  #tokenizerPromise: Promise<PreTrainedTokenizer>;
  #session: Promise<InferenceSession>;
  #tokenizer?: PreTrainedTokenizer;
  #logger = log();

  constructor() {
    super();
    this.#tokenizerPromise = AutoTokenizer.from_pretrained('livekit/turn-detector', {
      revision: 'v1.2.0',
      // local_files_only: true, // TODO(nbsp): can't find it
    });

    this.#session = InferenceSession.create(
      fileURLToPath(new URL('turn_detector.onnx', import.meta.url).href),
      {
        executionProviders: [{ name: 'cpu' }],
      },
    );
  }

  async initialize() {
    this.#tokenizer = await this.#tokenizerPromise;
  }

  async run(data: RawChatContext): Promise<number | undefined> {
    const text = this.#formatChatContext(data);
    const startTime = Date.now();
    const inputs = this.#tokenizer!.encode(text, { add_special_tokens: false });
    const outputs = await this.#session.then((session) =>
      session.run({ input_ids: new Tensor('int64', inputs, [1, inputs.length]) }, ['prob']),
    );
    const endTime = Date.now();
    const logits = outputs.prob!;
    const eouProbability = logits.data[0] as number;
    this.#logger
      .child({ eouProbability, input: text, duration: endTime - startTime })
      .debug('eou prediction');
    return eouProbability;
  }

  #formatChatContext(ctx: RawChatContext): string {
    const newCtx: RawChatContext = [];
    for (const msg of ctx) {
      if (!msg.content) continue;
      newCtx.push(msg);
    }

    const convoText = this.#tokenizer!.apply_chat_template(newCtx, {
      add_generation_prompt: false,
      tokenize: false,
    }) as string;
    // remove EOU token from current utterance
    return convoText.slice(0, convoText.lastIndexOf('<|im_end|>'));
  }

  async close() {
    await this.#session.then((session) => session.release());
  }
}

export class EOUModel {
  #executor: ipc.InferenceExecutor;
  #unlikelyThreshold: number;

  constructor(unlikelyThreshold: number = 0.15) {
    this.#unlikelyThreshold = unlikelyThreshold;
    this.#executor = CurrentJobContext.getCurrent().inferenceExecutor;
  }

  supportsLanguage(language?: string) {
    if (!language) return false;
    const parts = language.toLowerCase().split('-');
    return parts[0] === 'en' || parts[0] === 'english';
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  unlikelyThreshold(language?: string) {
    // TODO(AJS-155): add language support
    return this.#unlikelyThreshold;
  }

  async predictEndOfTurn(chatCtx: llm.ChatContext): Promise<number> {
    let messages: RawChatContext = [];

    for (const message of chatCtx.items) {
      // skip system and developer messages or tool call messages
      if (message.type !== 'message' || message.role in ['system', 'developer']) {
        continue;
      }

      if (typeof message.content === 'string') {
        messages.push({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: message.content,
        });
      } else if (Array.isArray(message.content)) {
        for (const content of message.content) {
          if (typeof content === 'string') {
            messages.push({
              role: message.role === 'assistant' ? 'assistant' : 'user',
              content: content,
            });
          }
        }
      }
    }
    messages = messages.slice(-MAX_HISTORY_TURNS);
    const result = await this.#executor.doInference(EOURunner.INFERENCE_METHOD, messages);
    return result as number;
  }
}

export default EOURunner;
