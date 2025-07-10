// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, log } from '@livekit/agents';
import { EOUModelBase, EOURunnerBase } from './base.js';

const REMOTE_INFERENCE_TIMEOUT = 2000;

export const INFERENCE_METHOD_MULTILINGUAL = 'lk_end_of_utterance_multilingual';

export class EUORunnerMultilingual extends EOURunnerBase {
  constructor() {
    super('multilingual');
  }
}

export class MultilingualModel extends EOUModelBase {
  #logger = log();

  constructor(unlikelyThreshold?: number) {
    super({
      modelType: 'multilingual',
      unlikelyThreshold,
    });
  }

  inferenceMethod(): string {
    return INFERENCE_METHOD_MULTILINGUAL;
  }

  async unlikelyThreshold(language?: string): Promise<number | undefined> {
    if (!language) {
      return undefined;
    }

    let threshold = await super.unlikelyThreshold(language);
    if (threshold === undefined) {
      const url = remoteInferenceUrl();
      if (!url) return undefined;

      const resp = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({
          language,
        }),
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(REMOTE_INFERENCE_TIMEOUT),
      });

      if (!resp.ok) {
        throw new Error(`Failed to fetch threshold: ${resp.statusText}`);
      }

      const data = (await resp.json()) as { threshold: number | undefined };
      threshold = data.threshold;
      if (threshold) {
        this.languages[language] = { threshold };
      }
    }

    return threshold;
  }

  async predictEndOfTurn(chatCtx: llm.ChatContext, timeout: number = 3): Promise<number> {
    const url = remoteInferenceUrl();
    if (!url) {
      return await super.predictEndOfTurn(chatCtx, timeout);
    }

    const startedAt = performance.now();
    const resp = await fetch(url, {
      method: 'POST',
      // TODO(brian): exclude function call messages
      body: JSON.stringify(chatCtx),
      headers: {
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(REMOTE_INFERENCE_TIMEOUT),
    });

    if (!resp.ok) {
      throw new Error(`Failed to predict end of turn: ${resp.statusText}`);
    }

    const data = await resp.json();
    const probability = data.probability;
    if (typeof probability === 'number' && probability >= 0) {
      this.#logger.debug(
        {
          eouProbability: probability,
          duration: (performance.now() - startedAt) / 1000,
        },
        'eou prediction',
      );
      return probability;
    }

    // default to indicate no prediction
    return 1;
  }
}

function remoteInferenceUrl() {
  const urlBase = process.env.LIVEKIT_REMOTE_EOT_URL;
  if (!urlBase) {
    return undefined;
  }
  return `${urlBase}/eot/multi`;
}

export default EUORunnerMultilingual;
