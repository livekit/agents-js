// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EOUModel, EOURunnerBase } from './base.js';

export const INFERENCE_METHOD_EN = 'lk_end_of_utterance_en';

export class EOURunnerEn extends EOURunnerBase {
  constructor() {
    super('en');
  }
}

export class EnglishModel extends EOUModel {
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
