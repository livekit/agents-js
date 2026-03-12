// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from 'vitest';
import type { LLMMetrics, RealtimeModelMetrics, STTMetrics, TTSMetrics } from './base.js';
import {
  type LLMModelUsage,
  ModelUsageCollector,
  type STTModelUsage,
  type TTSModelUsage,
  filterZeroValues,
} from './model_usage.js';

describe('model_usage', () => {
  describe('filterZeroValues', () => {
    it('should filter out zero values from LLMModelUsage', () => {
      const usage: LLMModelUsage = {
        type: 'llm_usage',
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 100,
        inputCachedTokens: 0,
        inputAudioTokens: 0,
        inputCachedAudioTokens: 0,
        inputTextTokens: 0,
        inputCachedTextTokens: 0,
        inputImageTokens: 0,
        inputCachedImageTokens: 0,
        outputTokens: 50,
        outputAudioTokens: 0,
        outputTextTokens: 0,
        sessionDurationMs: 0,
      };

      const filtered = filterZeroValues(usage);

      expect(filtered.type).toBe('llm_usage');
      expect(filtered.provider).toBe('openai');
      expect(filtered.model).toBe('gpt-4o');
      expect(filtered.inputTokens).toBe(100);
      expect(filtered.outputTokens).toBe(50);
      // Zero values should be filtered out
      expect(filtered.inputCachedTokens).toBeUndefined();
      expect(filtered.inputAudioTokens).toBeUndefined();
      expect(filtered.sessionDurationMs).toBeUndefined();
    });

    it('should filter out zero values from TTSModelUsage', () => {
      const usage: TTSModelUsage = {
        type: 'tts_usage',
        provider: 'elevenlabs',
        model: 'eleven_turbo_v2',
        inputTokens: 0,
        outputTokens: 0,
        charactersCount: 500,
        audioDurationMs: 3000,
      };

      const filtered = filterZeroValues(usage);

      expect(filtered.type).toBe('tts_usage');
      expect(filtered.provider).toBe('elevenlabs');
      expect(filtered.charactersCount).toBe(500);
      expect(filtered.audioDurationMs).toBe(3000);
      expect(filtered.inputTokens).toBeUndefined();
      expect(filtered.outputTokens).toBeUndefined();
    });

    it('should keep all values when none are zero', () => {
      const usage: STTModelUsage = {
        type: 'stt_usage',
        provider: 'deepgram',
        model: 'nova-2',
        inputTokens: 10,
        outputTokens: 20,
        audioDurationMs: 5000,
      };

      const filtered = filterZeroValues(usage);

      expect(Object.keys(filtered)).toHaveLength(6);
      expect(filtered).toEqual(usage);
    });
  });

  describe('ModelUsageCollector', () => {
    let collector: ModelUsageCollector;

    beforeEach(() => {
      collector = new ModelUsageCollector();
    });

    describe('collect LLM metrics', () => {
      it('should aggregate LLM metrics by provider and model', () => {
        const metrics1: LLMMetrics = {
          type: 'llm_metrics',
          label: 'test',
          requestId: 'req1',
          timestamp: Date.now(),
          durationMs: 100,
          ttftMs: 50,
          cancelled: false,
          completionTokens: 100,
          promptTokens: 200,
          promptCachedTokens: 50,
          totalTokens: 300,
          tokensPerSecond: 10,
          metadata: {
            modelProvider: 'openai',
            modelName: 'gpt-4o',
          },
        };

        const metrics2: LLMMetrics = {
          type: 'llm_metrics',
          label: 'test',
          requestId: 'req2',
          timestamp: Date.now(),
          durationMs: 150,
          ttftMs: 60,
          cancelled: false,
          completionTokens: 150,
          promptTokens: 300,
          promptCachedTokens: 75,
          totalTokens: 450,
          tokensPerSecond: 12,
          metadata: {
            modelProvider: 'openai',
            modelName: 'gpt-4o',
          },
        };

        collector.collect(metrics1);
        collector.collect(metrics2);

        const usage = collector.flatten();
        expect(usage).toHaveLength(1);

        const llmUsage = usage[0] as LLMModelUsage;
        expect(llmUsage.type).toBe('llm_usage');
        expect(llmUsage.provider).toBe('openai');
        expect(llmUsage.model).toBe('gpt-4o');
        expect(llmUsage.inputTokens).toBe(500); // 200 + 300
        expect(llmUsage.inputCachedTokens).toBe(125); // 50 + 75
        expect(llmUsage.outputTokens).toBe(250); // 100 + 150
      });

      it('should separate metrics by different providers', () => {
        const openaiMetrics: LLMMetrics = {
          type: 'llm_metrics',
          label: 'test',
          requestId: 'req1',
          timestamp: Date.now(),
          durationMs: 100,
          ttftMs: 50,
          cancelled: false,
          completionTokens: 100,
          promptTokens: 200,
          promptCachedTokens: 0,
          totalTokens: 300,
          tokensPerSecond: 10,
          metadata: {
            modelProvider: 'openai',
            modelName: 'gpt-4o',
          },
        };

        const anthropicMetrics: LLMMetrics = {
          type: 'llm_metrics',
          label: 'test',
          requestId: 'req2',
          timestamp: Date.now(),
          durationMs: 120,
          ttftMs: 55,
          cancelled: false,
          completionTokens: 80,
          promptTokens: 150,
          promptCachedTokens: 0,
          totalTokens: 230,
          tokensPerSecond: 8,
          metadata: {
            modelProvider: 'anthropic',
            modelName: 'claude-3-5-sonnet',
          },
        };

        collector.collect(openaiMetrics);
        collector.collect(anthropicMetrics);

        const usage = collector.flatten();
        expect(usage).toHaveLength(2);

        const openaiUsage = usage.find(
          (u) => u.type === 'llm_usage' && u.provider === 'openai',
        ) as LLMModelUsage;
        const anthropicUsage = usage.find(
          (u) => u.type === 'llm_usage' && u.provider === 'anthropic',
        ) as LLMModelUsage;

        expect(openaiUsage.inputTokens).toBe(200);
        expect(openaiUsage.outputTokens).toBe(100);
        expect(anthropicUsage.inputTokens).toBe(150);
        expect(anthropicUsage.outputTokens).toBe(80);
      });
    });

    describe('collect TTS metrics', () => {
      it('should aggregate TTS metrics by provider and model', () => {
        const metrics1: TTSMetrics = {
          type: 'tts_metrics',
          label: 'test',
          requestId: 'req1',
          timestamp: Date.now(),
          ttfbMs: 100,
          durationMs: 500,
          audioDurationMs: 3000,
          cancelled: false,
          charactersCount: 100,
          inputTokens: 10,
          outputTokens: 20,
          streamed: true,
          metadata: {
            modelProvider: 'elevenlabs',
            modelName: 'eleven_turbo_v2',
          },
        };

        const metrics2: TTSMetrics = {
          type: 'tts_metrics',
          label: 'test',
          requestId: 'req2',
          timestamp: Date.now(),
          ttfbMs: 120,
          durationMs: 600,
          audioDurationMs: 4000,
          cancelled: false,
          charactersCount: 200,
          inputTokens: 15,
          outputTokens: 25,
          streamed: true,
          metadata: {
            modelProvider: 'elevenlabs',
            modelName: 'eleven_turbo_v2',
          },
        };

        collector.collect(metrics1);
        collector.collect(metrics2);

        const usage = collector.flatten();
        expect(usage).toHaveLength(1);

        const ttsUsage = usage[0] as TTSModelUsage;
        expect(ttsUsage.type).toBe('tts_usage');
        expect(ttsUsage.provider).toBe('elevenlabs');
        expect(ttsUsage.model).toBe('eleven_turbo_v2');
        expect(ttsUsage.charactersCount).toBe(300); // 100 + 200
        expect(ttsUsage.audioDurationMs).toBe(7000); // 3000 + 4000
        expect(ttsUsage.inputTokens).toBe(25); // 10 + 15
        expect(ttsUsage.outputTokens).toBe(45); // 20 + 25
      });
    });

    describe('collect STT metrics', () => {
      it('should aggregate STT metrics by provider and model', () => {
        const metrics1: STTMetrics = {
          type: 'stt_metrics',
          label: 'test',
          requestId: 'req1',
          timestamp: Date.now(),
          durationMs: 0,
          audioDurationMs: 5000,
          inputTokens: 50,
          outputTokens: 100,
          streamed: true,
          metadata: {
            modelProvider: 'deepgram',
            modelName: 'nova-2',
          },
        };

        const metrics2: STTMetrics = {
          type: 'stt_metrics',
          label: 'test',
          requestId: 'req2',
          timestamp: Date.now(),
          durationMs: 0,
          audioDurationMs: 3000,
          inputTokens: 30,
          outputTokens: 60,
          streamed: true,
          metadata: {
            modelProvider: 'deepgram',
            modelName: 'nova-2',
          },
        };

        collector.collect(metrics1);
        collector.collect(metrics2);

        const usage = collector.flatten();
        expect(usage).toHaveLength(1);

        const sttUsage = usage[0] as STTModelUsage;
        expect(sttUsage.type).toBe('stt_usage');
        expect(sttUsage.provider).toBe('deepgram');
        expect(sttUsage.model).toBe('nova-2');
        expect(sttUsage.audioDurationMs).toBe(8000); // 5000 + 3000
        expect(sttUsage.inputTokens).toBe(80); // 50 + 30
        expect(sttUsage.outputTokens).toBe(160); // 100 + 60
      });
    });

    describe('collect realtime model metrics', () => {
      it('should aggregate realtime model metrics with detailed token breakdown', () => {
        const metrics: RealtimeModelMetrics = {
          type: 'realtime_model_metrics',
          label: 'test',
          requestId: 'req1',
          timestamp: Date.now(),
          durationMs: 1000,
          ttftMs: 100,
          cancelled: false,
          inputTokens: 500,
          outputTokens: 300,
          totalTokens: 800,
          tokensPerSecond: 10,
          sessionDurationMs: 5000,
          inputTokenDetails: {
            audioTokens: 200,
            textTokens: 250,
            imageTokens: 50,
            cachedTokens: 100,
            cachedTokensDetails: {
              audioTokens: 30,
              textTokens: 50,
              imageTokens: 20,
            },
          },
          outputTokenDetails: {
            textTokens: 200,
            audioTokens: 100,
            imageTokens: 0,
          },
          metadata: {
            modelProvider: 'openai',
            modelName: 'gpt-4o-realtime',
          },
        };

        collector.collect(metrics);

        const usage = collector.flatten();
        expect(usage).toHaveLength(1);

        const llmUsage = usage[0] as LLMModelUsage;
        expect(llmUsage.type).toBe('llm_usage');
        expect(llmUsage.provider).toBe('openai');
        expect(llmUsage.model).toBe('gpt-4o-realtime');
        expect(llmUsage.inputTokens).toBe(500);
        expect(llmUsage.inputCachedTokens).toBe(100);
        expect(llmUsage.inputAudioTokens).toBe(200);
        expect(llmUsage.inputCachedAudioTokens).toBe(30);
        expect(llmUsage.inputTextTokens).toBe(250);
        expect(llmUsage.inputCachedTextTokens).toBe(50);
        expect(llmUsage.inputImageTokens).toBe(50);
        expect(llmUsage.inputCachedImageTokens).toBe(20);
        expect(llmUsage.outputTokens).toBe(300);
        expect(llmUsage.outputTextTokens).toBe(200);
        expect(llmUsage.outputAudioTokens).toBe(100);
        expect(llmUsage.sessionDurationMs).toBe(5000);
      });
    });

    describe('mixed metrics collection', () => {
      it('should collect and separate LLM, TTS, and STT metrics', () => {
        const llmMetrics: LLMMetrics = {
          type: 'llm_metrics',
          label: 'test',
          requestId: 'req1',
          timestamp: Date.now(),
          durationMs: 100,
          ttftMs: 50,
          cancelled: false,
          completionTokens: 100,
          promptTokens: 200,
          promptCachedTokens: 0,
          totalTokens: 300,
          tokensPerSecond: 10,
          metadata: {
            modelProvider: 'openai',
            modelName: 'gpt-4o',
          },
        };

        const ttsMetrics: TTSMetrics = {
          type: 'tts_metrics',
          label: 'test',
          requestId: 'req2',
          timestamp: Date.now(),
          ttfbMs: 100,
          durationMs: 500,
          audioDurationMs: 3000,
          cancelled: false,
          charactersCount: 100,
          streamed: true,
          metadata: {
            modelProvider: 'elevenlabs',
            modelName: 'eleven_turbo_v2',
          },
        };

        const sttMetrics: STTMetrics = {
          type: 'stt_metrics',
          label: 'test',
          requestId: 'req3',
          timestamp: Date.now(),
          durationMs: 0,
          audioDurationMs: 5000,
          streamed: true,
          metadata: {
            modelProvider: 'deepgram',
            modelName: 'nova-2',
          },
        };

        collector.collect(llmMetrics);
        collector.collect(ttsMetrics);
        collector.collect(sttMetrics);

        const usage = collector.flatten();
        expect(usage).toHaveLength(3);

        const llmUsage = usage.find((u) => u.type === 'llm_usage');
        const ttsUsage = usage.find((u) => u.type === 'tts_usage');
        const sttUsage = usage.find((u) => u.type === 'stt_usage');

        expect(llmUsage).toBeDefined();
        expect(ttsUsage).toBeDefined();
        expect(sttUsage).toBeDefined();
      });
    });

    describe('flatten returns copies', () => {
      it('should return deep copies of usage objects', () => {
        const metrics: LLMMetrics = {
          type: 'llm_metrics',
          label: 'test',
          requestId: 'req1',
          timestamp: Date.now(),
          durationMs: 100,
          ttftMs: 50,
          cancelled: false,
          completionTokens: 100,
          promptTokens: 200,
          promptCachedTokens: 0,
          totalTokens: 300,
          tokensPerSecond: 10,
          metadata: {
            modelProvider: 'openai',
            modelName: 'gpt-4o',
          },
        };

        collector.collect(metrics);

        const usage1 = collector.flatten();
        const usage2 = collector.flatten();

        // Should be equal values
        expect(usage1[0]).toEqual(usage2[0]);

        // But not the same object reference
        expect(usage1[0]).not.toBe(usage2[0]);

        // Modifying one shouldn't affect the other
        (usage1[0] as LLMModelUsage).inputTokens = 9999;
        expect((usage2[0] as LLMModelUsage).inputTokens).toBe(200);
      });
    });

    describe('handles missing metadata', () => {
      it('should use empty strings when metadata is missing', () => {
        const metrics: LLMMetrics = {
          type: 'llm_metrics',
          label: 'test',
          requestId: 'req1',
          timestamp: Date.now(),
          durationMs: 100,
          ttftMs: 50,
          cancelled: false,
          completionTokens: 100,
          promptTokens: 200,
          promptCachedTokens: 0,
          totalTokens: 300,
          tokensPerSecond: 10,
          // No metadata
        };

        collector.collect(metrics);

        const usage = collector.flatten();
        expect(usage).toHaveLength(1);

        const llmUsage = usage[0] as LLMModelUsage;
        expect(llmUsage.provider).toBe('');
        expect(llmUsage.model).toBe('');
      });
    });

    describe('ignores VAD and EOU metrics', () => {
      it('should not collect VAD metrics', () => {
        const vadMetrics = {
          type: 'vad_metrics' as const,
          label: 'test',
          timestamp: Date.now(),
          idleTimeMs: 100,
          inferenceDurationTotalMs: 50,
          inferenceCount: 10,
        };

        collector.collect(vadMetrics);

        const usage = collector.flatten();
        expect(usage).toHaveLength(0);
      });

      it('should not collect EOU metrics', () => {
        const eouMetrics = {
          type: 'eou_metrics' as const,
          timestamp: Date.now(),
          endOfUtteranceDelayMs: 100,
          transcriptionDelayMs: 50,
          onUserTurnCompletedDelayMs: 30,
          lastSpeakingTimeMs: Date.now(),
        };

        collector.collect(eouMetrics);

        const usage = collector.flatten();
        expect(usage).toHaveLength(0);
      });
    });
  });
});
