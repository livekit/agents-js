// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AutoTokenizer, type PreTrainedTokenizer } from '@huggingface/transformers';
import type { ipc, llm } from '@livekit/agents';
import { CurrentJobContext, InferenceRunner, log } from '@livekit/agents';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { type EOUModelType, MAX_HISTORY_TURNS, MODEL_REVISIONS } from './constants.js';

type RawChatItem = { role: string; content: string };

type EOUOutput = { eouProbability: number; input: string; duration: number };

export abstract class EOURunnerBase extends InferenceRunner<RawChatItem[], EOUOutput> {
  private modelType: EOUModelType;
  private modelRevision: string;

  private session?: InferenceSession;
  private tokenizer?: PreTrainedTokenizer;

  #logger = log();

  constructor(modelType: EOUModelType) {
    super();
    this.modelType = modelType;
    this.modelRevision = MODEL_REVISIONS[modelType];
  }

  async initialize() {
    // TODO(brian): dynamic import of the HF tokenizer

    // TODO(brian): remove hardcoded path and support downloading the model from HF hub
    const onnxModelPath = fileURLToPath(new URL('turn_detector.onnx', import.meta.url).href);

    try {
      // TODO(brian): support session config once onnxruntime-node supports it
      const sessOptions: InferenceSession.SessionOptions = {
        intraOpNumThreads: Math.max(1, Math.floor(os.cpus().length / 2)),
        interOpNumThreads: 1,
        executionProviders: [{ name: 'cpu' }],
      };

      this.session = await InferenceSession.create(onnxModelPath, sessOptions);

      this.tokenizer = await AutoTokenizer.from_pretrained('livekit/turn-detector', {
        revision: this.modelRevision,
        //   local_files_only: true,  // TODO(brian): support local_files_only
      });
    } catch (e) {
      throw new Error(
        `agents-plugins-livekit failed to initialize ${this.modelType} EOU turn detector: ${e}`,
      );
    }
  }

  async run(data: RawChatItem[]) {
    const startTime = Date.now();

    const text = this.formatChatCtx(data);

    // TODO(brian): investigate max_length and truncation options
    const inputs = this.tokenizer!.encode(text, { add_special_tokens: false });
    const outputs = await this.session!.run(
      { input_ids: new Tensor('int64', inputs, [1, inputs.length]) },
      ['prob'],
    );

    const eouProbability = outputs.prob!.data[0] as number;
    const endTime = Date.now();

    const result = {
      eouProbability,
      input: text,
      duration: (endTime - startTime) / 1000,
    };

    this.#logger.child({ result }).debug('eou prediction');
    return result;
  }

  async close() {
    await this.session?.release();
  }

  private formatChatCtx(chatCtx: RawChatItem[]): string {
    const newChatCtx: RawChatItem[] = [];
    let lastMsg: RawChatItem | undefined = undefined;

    for (const msg of chatCtx) {
      const content = msg.content;
      if (!content) continue;

      // need to combine adjacent turns together to match training data
      if (lastMsg !== undefined && lastMsg.role === msg.role) {
        lastMsg.content += content;
      } else {
        newChatCtx.push(msg);
        lastMsg = msg;
      }
    }

    // TODO(brian): investigate add_special_tokens options
    const convoText = this.tokenizer!.apply_chat_template(newChatCtx, {
      add_generation_prompt: false,
      tokenize: false,
    }) as string;

    // remove the EOU token from current utterance
    return convoText.slice(0, convoText.lastIndexOf('<|im_end|>'));
  }
}

export interface EOUModelOptions {
  modelType: EOUModelType;
  executor?: ipc.InferenceExecutor;
  unlikelyThreshold?: number;
  loadLanguages?: boolean;
}

export abstract class EOUModelBase {
  private modelType: EOUModelType;
  private executor: ipc.InferenceExecutor;
  private threshold: number | undefined;
  private loadLanguages: boolean;

  // TODO(brian): add type annotation for languages
  protected languages: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any

  #logger = log();

  constructor(opts: EOUModelOptions) {
    const {
      modelType = 'en',
      executor = CurrentJobContext.getCurrent().inferenceExecutor,
      unlikelyThreshold = 0.15,
      loadLanguages = true,
    } = opts;

    this.modelType = modelType;
    this.executor = executor;
    this.threshold = unlikelyThreshold;
    this.loadLanguages = loadLanguages;

    if (loadLanguages) {
      // TODO(brian): support load languages.json from HF hub
      this.#logger.warn('Loading languages.json from HF hub is not implemented');
    }
  }

  async unlikelyThreshold(language?: string): Promise<number | undefined> {
    if (language === undefined) {
      return this.threshold;
    }

    const lang = language.toLowerCase();
    // try the full language code first
    let langData = this.languages[lang];

    if (langData === undefined && lang.includes('-')) {
      const baseLang = lang.split('-')[0]!;
      langData = this.languages[baseLang];
    }

    if (langData === undefined) {
      this.#logger.warn(`Language ${language} not supported by EOU model`);
      return this.threshold;
    }

    // if a custom threshold is provided, use it
    if (this.threshold !== undefined) {
      return this.threshold;
    }

    return langData.threshold;
  }

  async supportsLanguage(language?: string): Promise<boolean> {
    return (await this.unlikelyThreshold(language)) !== undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async predictEndOfTurn(chatCtx: llm.ChatContext, timeout: number = 3): Promise<number> {
    let messages: RawChatItem[] = [];

    for (const message of chatCtx.items) {
      // skip system and developer messages or tool call messages
      if (message.type !== 'message' || message.role in ['system', 'developer']) {
        continue;
      }

      for (const content of message.content) {
        if (typeof content === 'string') {
          messages.push({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: content,
          });
        }
      }
    }

    messages = messages.slice(-MAX_HISTORY_TURNS);

    const result = await this.executor.doInference(this.inferenceMethod(), messages);
    if (result === undefined) {
      throw new Error('EOU inference should always returns a result');
    }

    return (result as EOUOutput).eouProbability;
  }

  abstract inferenceMethod(): string;
}
