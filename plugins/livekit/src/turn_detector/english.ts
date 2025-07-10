import { EOUModelBase, EOURunnerBase } from './base.js';

export const INFERENCE_METHOD_EN = 'lk_end_of_utterance_en';

export class EOURunnerEn extends EOURunnerBase {
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
    return INFERENCE_METHOD_EN;
  }
}

export default EOURunnerEn;
