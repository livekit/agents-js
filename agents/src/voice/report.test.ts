// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import type { ModelUsage } from '../metrics/model_usage.js';
import type { AgentSessionOptions, VoiceOptions } from './agent_session.js';
import { AgentSessionEventTypes, createSessionUsageUpdatedEvent } from './events.js';
import type { AgentSessionUsage } from './index.js';
import { createSessionReport, sessionReportToJSON } from './report.js';

type ReportOptions = AgentSessionOptions & Partial<VoiceOptions>;

function baseOptions(): ReportOptions {
  return {
    maxToolSteps: 3,
    userAwayTimeout: 15,
    useTtsAlignedTranscript: true,
    turnHandling: {
      preemptiveGeneration: { enabled: false },
    },
  };
}

function serializeOptions(options: ReportOptions) {
  const report = createSessionReport({
    jobId: 'job',
    roomId: 'room-id',
    room: 'room',
    options,
    events: [],
    chatHistory: ChatContext.empty(),
    enableRecording: false,
    timestamp: 0,
    startedAt: 0,
  });

  const payload = sessionReportToJSON(report);
  return payload.options as Record<string, unknown>;
}

describe('sessionReportToJSON', () => {
  it('serializes interruption and endpointing values from turnHandling', () => {
    const options = baseOptions();
    options.turnHandling = {
      interruption: {
        mode: 'adaptive',
        discardAudioIfUninterruptible: false,
        minDuration: 1200,
        minWords: 2,
      },
      endpointing: {
        minDelay: 900,
        maxDelay: 4500,
      },
    };

    const serialized = serializeOptions(options);
    expect(serialized).toMatchObject({
      allow_interruptions: true,
      discard_audio_if_uninterruptible: false,
      min_interruption_duration: 1200,
      min_interruption_words: 2,
      min_endpointing_delay: 900,
      max_endpointing_delay: 4500,
      max_tool_steps: 3,
    });
  });

  it('prefers turnHandling values over deprecated flat fields', () => {
    const options = baseOptions();
    options.allowInterruptions = false;
    options.discardAudioIfUninterruptible = true;
    options.minInterruptionDuration = 400;
    options.minInterruptionWords = 1;
    options.minEndpointingDelay = 500;
    options.maxEndpointingDelay = 2500;
    options.turnHandling = {
      interruption: {
        mode: 'vad',
        discardAudioIfUninterruptible: false,
        minDuration: 1400,
        minWords: 4,
      },
      endpointing: {
        minDelay: 700,
        maxDelay: 3900,
      },
    };

    const serialized = serializeOptions(options);
    expect(serialized).toMatchObject({
      allow_interruptions: true,
      discard_audio_if_uninterruptible: false,
      min_interruption_duration: 1400,
      min_interruption_words: 4,
      min_endpointing_delay: 700,
      max_endpointing_delay: 3900,
      max_tool_steps: 3,
    });
  });

  it('serializes allow_interruptions from interruption.enabled when present', () => {
    const options = baseOptions();
    options.allowInterruptions = true;
    options.turnHandling = {
      interruption: {
        enabled: false,
        mode: 'adaptive',
      },
    };

    const serialized = serializeOptions(options);
    expect(serialized).toMatchObject({
      allow_interruptions: false,
      max_tool_steps: 3,
    });
  });

  it('falls back to deprecated flat fields when turnHandling values are absent', () => {
    const options = baseOptions();
    options.allowInterruptions = false;
    options.discardAudioIfUninterruptible = false;
    options.minInterruptionDuration = 600;
    options.minInterruptionWords = 3;
    options.minEndpointingDelay = 1000;
    options.maxEndpointingDelay = 5000;

    const serialized = serializeOptions(options);
    expect(serialized).toMatchObject({
      allow_interruptions: false,
      discard_audio_if_uninterruptible: false,
      min_interruption_duration: 600,
      min_interruption_words: 3,
      min_endpointing_delay: 1000,
      max_endpointing_delay: 5000,
      max_tool_steps: 3,
    });
  });

  it('serializes model usage as usage', () => {
    const usage: ModelUsage[] = [
      {
        type: 'tts_usage',
        provider: 'elevenlabs',
        model: 'eleven_flash_v2_5',
        inputTokens: 0,
        outputTokens: 0,
        charactersCount: 42,
        audioDurationMs: 1200,
      },
    ];

    const report = createSessionReport({
      jobId: 'job',
      roomId: 'room-id',
      room: 'room',
      options: baseOptions(),
      events: [],
      chatHistory: ChatContext.empty(),
      enableRecording: false,
      timestamp: 0,
      startedAt: 0,
      modelUsage: usage,
    });

    const payload = sessionReportToJSON(report);
    expect(payload.usage).toEqual([
      {
        type: 'tts_usage',
        provider: 'elevenlabs',
        model: 'eleven_flash_v2_5',
        charactersCount: 42,
        audioDurationMs: 1200,
      },
    ]);
  });

  it('omits session usage update events from serialized events', () => {
    const report = createSessionReport({
      jobId: 'job',
      roomId: 'room-id',
      room: 'room',
      options: baseOptions(),
      events: [
        createSessionUsageUpdatedEvent({
          usage: {
            modelUsage: [
              {
                type: 'tts_usage',
                provider: 'elevenlabs',
                model: 'eleven_flash_v2_5',
              },
            ],
          },
          createdAt: 123,
        }),
      ],
      chatHistory: ChatContext.empty(),
      enableRecording: false,
      timestamp: 0,
      startedAt: 0,
    });

    const payload = sessionReportToJSON(report);
    expect(payload.events).toEqual([]);
  });

  it('exports AgentSessionUsage from the voice barrel', () => {
    const usage: AgentSessionUsage = { modelUsage: [] };
    const eventType: AgentSessionEventTypes = AgentSessionEventTypes.SessionUsageUpdated;
    expect(usage.modelUsage).toEqual([]);
    expect(eventType).toBe('session_usage_updated');
  });
});
