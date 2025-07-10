import { AutoTokenizer, type PreTrainedTokenizer } from '@huggingface/transformers';
import { InferenceRunner } from 'agents/dist/inference_runner.js';
import { log } from 'agents/dist/log.js';
import os from 'node:os';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { fileURLToPath } from 'url';
import { type EOUModelType, MODEL_REVISIONS } from './constants.js';

type RawChatItem = { role: string; content: string };
type EOUOutput = { eouProbability: number; input: string; duration: number };

abstract class _EOURunnerBase extends InferenceRunner<RawChatItem[], EOUOutput> {
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
      duration: endTime - startTime,
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
