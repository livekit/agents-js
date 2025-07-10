import { EOUModelBase, EOURunnerBase } from './base.js';

class EOURunnerEn extends EOURunnerBase {
  INFERENCE_METHOD = 'lk_end_of_utterance_en';

  constructor() {
    super('en');
  }
}

export class EnglishModel extends EOUModelBase {
  constructor(unlikelyThreshold?: number) {
    super({
      modelType: 'en',
      unlikelyThreshold,
    });
  }

  inferenceMethod(): string {
    return EOURunnerEn.INFERENCE_METHOD;
  }
}
