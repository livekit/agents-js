// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type PreTrainedTokenizer } from '@huggingface/transformers';
import type { ipc, llm } from '@livekit/agents';
import { Future, InferenceRunner, getJobContext, log } from '@livekit/agents';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { downloadFileToCacheDir } from '../hf_utils.js';
import {
  type EOUModelType,
  HG_MODEL_REPO,
  MAX_HISTORY_TURNS,
  MODEL_REVISIONS,
  ONNX_FILEPATH,
} from './constants.js';
import { normalizeText } from './utils.js';

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
    const { AutoTokenizer } = await import('@huggingface/transformers');

    try {
      const onnxModelPath = await downloadFileToCacheDir({
        repo: HG_MODEL_REPO,
        path: ONNX_FILEPATH,
        revision: this.modelRevision,
        localFileOnly: true,
      });

      // TODO(brian): support session config once onnxruntime-node supports it
      const sessOptions: InferenceSession.SessionOptions = {
        intraOpNumThreads: Math.max(1, Math.floor(os.cpus().length / 2)),
        interOpNumThreads: 1,
        executionProviders: [{ name: 'cpu' }],
      };

      this.session = await InferenceSession.create(onnxModelPath, sessOptions);

      this.tokenizer = await AutoTokenizer.from_pretrained('livekit/turn-detector', {
        revision: this.modelRevision,
        local_files_only: true,
      });
    } catch (e) {
      const errorMessage = String(e);

      // Check if the error is related to missing local files
      if (
        errorMessage.includes('local_files_only=true') ||
        errorMessage.includes('file was not found locally') ||
        errorMessage.includes('File not found in cache')
      ) {
        throw new Error(
          `agents-plugins-livekit failed to initialize ${this.modelType} EOU turn detector: Required model files not found locally.\n\n` +
            `This usually means you need to download the model files first. Please run one of these commands:\n\n` +
            `  If using Node.js starter template:\n` +
            `    pnpm download-files\n\n` +
            `  If using the agent directly:\n` +
            `    node ./your_agent.ts download-files\n\n` +
            `Then try running your application again.\n\n` +
            `Original error: ${e}`,
        );
      }

      throw new Error(
        `agents-plugins-livekit failed to initialize ${this.modelType} EOU turn detector: ${e}`,
      );
    }
  }

  async run(data: RawChatItem[]) {
    const startTime = Date.now();

    const text = this.formatChatCtx(data);

    const inputs = this.tokenizer!.encode(text, { add_special_tokens: false });
    this.#logger.debug({ inputs: JSON.stringify(inputs), text }, 'EOU inputs');

    const outputs = await this.session!.run(
      { input_ids: new Tensor('int64', inputs, [1, inputs.length]) },
      ['prob'],
    );

    const probData = outputs.prob!.data;
    // should be the logits of the last token
    const eouProbability = probData[probData.length - 1] as number;
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

      const norm = normalizeText(content);

      // need to combine adjacent turns together to match training data
      if (lastMsg !== undefined && lastMsg.role === msg.role) {
        lastMsg.content += ` ${norm}`;
      } else {
        newChatCtx.push({ role: msg.role, content: norm });
        lastMsg = newChatCtx[newChatCtx.length - 1]!;
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

type LanguageData = {
  threshold: number;
};

export abstract class EOUModel {
  private modelType: EOUModelType;
  private executor: ipc.InferenceExecutor;
  private threshold: number | undefined;
  private loadLanguages: boolean;

  protected languagesFuture: Future<Record<string, LanguageData>> = new Future();

  #logger = log();

  constructor(opts: EOUModelOptions) {
    const {
      modelType = 'en',
      executor = getJobContext().inferenceExecutor,
      unlikelyThreshold,
      loadLanguages = true,
    } = opts;

    this.modelType = modelType;
    this.executor = executor;
    this.threshold = unlikelyThreshold;
    this.loadLanguages = loadLanguages;

    if (loadLanguages) {
      downloadFileToCacheDir({
        repo: HG_MODEL_REPO,
        path: 'languages.json',
        revision: MODEL_REVISIONS[modelType],
        localFileOnly: true,
      }).then((path) => {
        this.languagesFuture.resolve(JSON.parse(readFileSync(path, 'utf8')));
      });
    }
  }

  async unlikelyThreshold(language?: string): Promise<number | undefined> {
    if (language === undefined) {
      return this.threshold;
    }

    const lang = language.toLowerCase();
    const languages = await this.languagesFuture.await;

    // try the full language code first
    let langData = languages[lang];

    if (langData === undefined && lang.includes('-')) {
      const baseLang = lang.split('-')[0]!;
      langData = languages[baseLang];
    }

    if (langData === undefined) {
      this.#logger.warn(`Language ${language} not supported by EOU model`);
      return undefined;
    }

    // if a custom threshold is provided, use it
    return this.threshold !== undefined ? this.threshold : langData.threshold;
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
