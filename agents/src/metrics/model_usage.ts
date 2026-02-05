// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type {
  AgentMetrics,
  LLMMetrics,
  RealtimeModelMetrics,
  STTMetrics,
  TTSMetrics,
} from './base.js';

export type LLMModelUsage = {
  type: 'llm_usage';
  /** The provider name (e.g., 'openai', 'anthropic'). */
  provider: string;
  /** The model name (e.g., 'gpt-4o', 'claude-3-5-sonnet'). */
  model: string;
  /** Total input tokens. */
  inputTokens: number;
  /** Input tokens served from cache. */
  inputCachedTokens: number;
  /** Input audio tokens (for multimodal models). */
  inputAudioTokens: number;
  /** Cached input audio tokens. */
  inputCachedAudioTokens: number;
  /** Input text tokens. */
  inputTextTokens: number;
  /** Cached input text tokens. */
  inputCachedTextTokens: number;
  /** Input image tokens (for multimodal models). */
  inputImageTokens: number;
  /** Cached input image tokens. */
  inputCachedImageTokens: number;
  /** Total output tokens. */
  outputTokens: number;
  /** Output audio tokens (for multimodal models). */
  outputAudioTokens: number;
  /** Output text tokens. */
  outputTextTokens: number;
  /** Total session connection duration in milliseconds (for session-based billing like xAI). */
  sessionDurationMs: number;
};

export type TTSModelUsage = {
  type: 'tts_usage';
  /** The provider name (e.g., 'elevenlabs', 'cartesia'). */
  provider: string;
  /** The model name (e.g., 'eleven_turbo_v2', 'sonic'). */
  model: string;
  /** Input text tokens (for token-based TTS billing, e.g., OpenAI TTS). */
  inputTokens: number;
  /** Output audio tokens (for token-based TTS billing, e.g., OpenAI TTS). */
  outputTokens: number;
  /** Number of characters synthesized (for character-based TTS billing). */
  charactersCount: number;
  /**
   * Duration of generated audio in milliseconds.
   */
  audioDurationMs: number;
};

export type STTModelUsage = {
  type: 'stt_usage';
  /** The provider name (e.g., 'deepgram', 'assemblyai'). */
  provider: string;
  /** The model name (e.g., 'nova-2', 'best'). */
  model: string;
  /** Input audio tokens (for token-based STT billing). */
  inputTokens: number;
  /** Output text tokens (for token-based STT billing). */
  outputTokens: number;
  /** Duration of processed audio in milliseconds. */
  audioDurationMs: number;
};

export type ModelUsage = LLMModelUsage | TTSModelUsage | STTModelUsage;

export function filterZeroValues<T extends ModelUsage>(usage: T): Partial<T> {
  const result: Partial<T> = {} as Partial<T>;
  for (const [key, value] of Object.entries(usage)) {
    if (value !== 0 && value !== 0.0) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export class ModelUsageCollector {
  private llmUsage: Map<string, LLMModelUsage> = new Map();
  private ttsUsage: Map<string, TTSModelUsage> = new Map();
  private sttUsage: Map<string, STTModelUsage> = new Map();

  /** Extract provider and model from metrics metadata. */
  private extractProviderModel(
    metrics: LLMMetrics | STTMetrics | TTSMetrics | RealtimeModelMetrics,
  ): [string, string] {
    let provider = '';
    let model = '';
    if (metrics.metadata) {
      provider = metrics.metadata.modelProvider || '';
      model = metrics.metadata.modelName || '';
    }
    return [provider, model];
  }

  /** Get or create an LLMModelUsage for the given provider/model combination. */
  private getLLMUsage(provider: string, model: string): LLMModelUsage {
    const key = `${provider}:${model}`;
    let usage = this.llmUsage.get(key);
    if (!usage) {
      usage = {
        type: 'llm_usage',
        provider,
        model,
        inputTokens: 0,
        inputCachedTokens: 0,
        inputAudioTokens: 0,
        inputCachedAudioTokens: 0,
        inputTextTokens: 0,
        inputCachedTextTokens: 0,
        inputImageTokens: 0,
        inputCachedImageTokens: 0,
        outputTokens: 0,
        outputAudioTokens: 0,
        outputTextTokens: 0,
        sessionDurationMs: 0,
      };
      this.llmUsage.set(key, usage);
    }
    return usage;
  }

  /** Get or create a TTSModelUsage for the given provider/model combination. */
  private getTTSUsage(provider: string, model: string): TTSModelUsage {
    const key = `${provider}:${model}`;
    let usage = this.ttsUsage.get(key);
    if (!usage) {
      usage = {
        type: 'tts_usage',
        provider,
        model,
        inputTokens: 0,
        outputTokens: 0,
        charactersCount: 0,
        audioDurationMs: 0,
      };
      this.ttsUsage.set(key, usage);
    }
    return usage;
  }

  /** Get or create an STTModelUsage for the given provider/model combination. */
  private getSTTUsage(provider: string, model: string): STTModelUsage {
    const key = `${provider}:${model}`;
    let usage = this.sttUsage.get(key);
    if (!usage) {
      usage = {
        type: 'stt_usage',
        provider,
        model,
        inputTokens: 0,
        outputTokens: 0,
        audioDurationMs: 0,
      };
      this.sttUsage.set(key, usage);
    }
    return usage;
  }

  /** Collect metrics and aggregate usage by model/provider. */
  collect(metrics: AgentMetrics): void {
    if (metrics.type === 'llm_metrics') {
      const [provider, model] = this.extractProviderModel(metrics);
      const usage = this.getLLMUsage(provider, model);
      usage.inputTokens += metrics.promptTokens;
      usage.inputCachedTokens += metrics.promptCachedTokens;
      usage.outputTokens += metrics.completionTokens;
    } else if (metrics.type === 'realtime_model_metrics') {
      const [provider, model] = this.extractProviderModel(metrics);
      const usage = this.getLLMUsage(provider, model);
      usage.inputTokens += metrics.inputTokens;
      usage.inputCachedTokens += metrics.inputTokenDetails.cachedTokens;

      usage.inputTextTokens += metrics.inputTokenDetails.textTokens;
      usage.inputCachedTextTokens += metrics.inputTokenDetails.cachedTokensDetails?.textTokens ?? 0;
      usage.inputImageTokens += metrics.inputTokenDetails.imageTokens;
      usage.inputCachedImageTokens +=
        metrics.inputTokenDetails.cachedTokensDetails?.imageTokens ?? 0;
      usage.inputAudioTokens += metrics.inputTokenDetails.audioTokens;
      usage.inputCachedAudioTokens +=
        metrics.inputTokenDetails.cachedTokensDetails?.audioTokens ?? 0;

      usage.outputTextTokens += metrics.outputTokenDetails.textTokens;
      usage.outputAudioTokens += metrics.outputTokenDetails.audioTokens;
      usage.outputTokens += metrics.outputTokens;
      usage.sessionDurationMs += metrics.sessionDurationMs ?? 0;
    } else if (metrics.type === 'tts_metrics') {
      const [provider, model] = this.extractProviderModel(metrics);
      const ttsUsage = this.getTTSUsage(provider, model);
      ttsUsage.inputTokens += metrics.inputTokens ?? 0;
      ttsUsage.outputTokens += metrics.outputTokens ?? 0;
      ttsUsage.charactersCount += metrics.charactersCount;
      ttsUsage.audioDurationMs += metrics.audioDurationMs;
    } else if (metrics.type === 'stt_metrics') {
      const [provider, model] = this.extractProviderModel(metrics);
      const sttUsage = this.getSTTUsage(provider, model);
      sttUsage.inputTokens += metrics.inputTokens ?? 0;
      sttUsage.outputTokens += metrics.outputTokens ?? 0;
      sttUsage.audioDurationMs += metrics.audioDurationMs;
    }
    // VAD and EOU metrics are not aggregated for usage tracking.
  }

  flatten(): ModelUsage[] {
    const result: ModelUsage[] = [];
    for (const u of this.llmUsage.values()) {
      result.push({ ...u });
    }
    for (const u of this.ttsUsage.values()) {
      result.push({ ...u });
    }
    for (const u of this.sttUsage.values()) {
      result.push({ ...u });
    }
    return result;
  }
}
