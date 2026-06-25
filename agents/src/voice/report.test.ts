// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { AudioContent, ImageContent } from '../llm/chat_context.js';
import { ChatContext, FunctionCall, FunctionCallOutput } from '../llm/chat_context.js';
import type { ModelUsage } from '../metrics/model_usage.js';
import type {
  AgentSessionOptions,
  ResolvedRecordingOptions,
  VoiceOptions,
} from './agent_session.js';
import {
  AgentSessionEventTypes,
  createConversationItemAddedEvent,
  createSessionUsageUpdatedEvent,
  createUserInputTranscribedEvent,
  createUserStateChangedEvent,
} from './events.js';
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
        characters_count: 42,
        audio_duration: 1.2,
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

  it('serializes events with snake_case keys to match the Python wire format', () => {
    const chatHistory = ChatContext.empty();
    const msg = chatHistory.addMessage({ role: 'user', content: 'hi', createdAt: 5 });

    const report = createSessionReport({
      jobId: 'job',
      roomId: 'room-id',
      room: 'room',
      options: baseOptions(),
      events: [
        createUserStateChangedEvent('listening', 'speaking', 7),
        createUserInputTranscribedEvent({
          transcript: 'hello',
          isFinal: true,
          speakerId: 'spk_1',
          createdAt: 9,
        }),
        createConversationItemAddedEvent(msg, 11),
      ],
      chatHistory,
      enableRecording: false,
      timestamp: 0,
      startedAt: 0,
    });

    const payload = sessionReportToJSON(report);
    expect(payload.events).toEqual([
      { type: 'user_state_changed', old_state: 'listening', new_state: 'speaking', created_at: 7 },
      {
        type: 'user_input_transcribed',
        transcript: 'hello',
        is_final: true,
        speaker_id: 'spk_1',
        language: null,
        created_at: 9,
      },
      {
        type: 'conversation_item_added',
        // chat items expose camelCase via toJSON(); the report layer converts to the
        // snake_case wire shape (e.g. created_at).
        item: {
          id: msg.id,
          type: 'message',
          role: 'user',
          content: ['hi'],
          interrupted: false,
          created_at: 5,
        },
        created_at: 11,
      },
    ]);
  });

  it('includes audio recording and sdk metadata in the report', () => {
    const report = createSessionReport({
      jobId: 'job',
      roomId: 'room-id',
      room: 'room',
      options: baseOptions(),
      events: [],
      chatHistory: ChatContext.empty(),
      enableRecording: true,
      timestamp: 0,
      startedAt: 0,
      audioRecordingPath: '/tmp/audio.ogg',
      audioRecordingStartedAt: 1234,
    });

    const payload = sessionReportToJSON(report);
    expect(payload.audio_recording_path).toBe('/tmp/audio.ogg');
    expect(payload.audio_recording_started_at).toBe(1234);
    expect(typeof payload.sdk_version).toBe('string');
    expect((payload.options as Record<string, unknown>).user_away_timeout).toBe(15);
  });

  it('serializes the full chat history to the Python snake_case wire format', () => {
    // Mirrors the camelCase fixtures snapshotted in chat_context.test.ts, but asserts the
    // *converted* output: `chat_history` is what the report layer (toSnakeCaseDeep) emits, so
    // this locks down the js->python field mapping for every chat-item type — message,
    // multimodal content (image/audio), function_call (args->arguments), and
    // function_call_output (isError->is_error).
    const chatHistory = new ChatContext();

    chatHistory.addMessage({
      id: 'msg_user_1',
      role: 'user',
      content: [
        'Check out this image and audio:',
        {
          id: 'img_test_1',
          type: 'image_content',
          image: 'https://example.com/test-image.jpg',
          inferenceDetail: 'high',
          inferenceWidth: 1024,
          inferenceHeight: 768,
          mimeType: 'image/jpeg',
          _cache: {},
        } satisfies ImageContent,
        {
          type: 'audio_content',
          frame: [],
          transcript: 'This is a test audio transcript',
        } satisfies AudioContent,
      ],
      createdAt: 3000000000,
    });

    chatHistory.insert(
      new FunctionCall({
        id: 'func_call_1',
        callId: 'call_weather_123',
        name: 'get_weather',
        args: '{"location": "Paris, France", "unit": "celsius"}',
        groupId: 'grp_1',
        thoughtSignature: 'sig_abc',
        createdAt: 3000000001,
      }),
    );

    chatHistory.insert(
      new FunctionCallOutput({
        id: 'func_output_1',
        callId: 'call_weather_123',
        name: 'get_weather',
        output: '{"temperature": 22, "condition": "partly cloudy"}',
        isError: false,
        createdAt: 3000000002,
      }),
    );

    chatHistory.addMessage({
      id: 'msg_assistant_1',
      role: 'assistant',
      content: 'It is 22°C and partly cloudy in Paris.',
      interrupted: false,
      createdAt: 3000000003,
    });

    const report = createSessionReport({
      jobId: 'job',
      roomId: 'room-id',
      room: 'room',
      options: baseOptions(),
      events: [],
      chatHistory,
      enableRecording: false,
      timestamp: 0,
      startedAt: 0,
    });

    const payload = sessionReportToJSON(report);
    expect(payload.chat_history).toMatchSnapshot('chat-history-python-wire');
  });

  it('exports AgentSessionUsage from the voice barrel', () => {
    const usage: AgentSessionUsage = { modelUsage: [] };
    const eventType: AgentSessionEventTypes = AgentSessionEventTypes.SessionUsageUpdated;
    expect(usage.modelUsage).toEqual([]);
    expect(eventType).toBe('session_usage_updated');
  });
});

describe('createSessionReport recordingOptions', () => {
  function makeReport(recordingOptions?: ResolvedRecordingOptions) {
    return createSessionReport({
      jobId: 'job',
      roomId: 'room-id',
      room: 'room',
      options: baseOptions(),
      events: [],
      chatHistory: ChatContext.empty(),
      recordingOptions,
    });
  }

  it('defaults every recording category to off when omitted', () => {
    expect(makeReport().recordingOptions).toEqual({
      audio: false,
      traces: false,
      logs: false,
      transcript: false,
    });
  });

  it('passes provided recording options through', () => {
    const recordingOptions: ResolvedRecordingOptions = {
      audio: true,
      traces: false,
      logs: true,
      transcript: false,
    };
    expect(makeReport(recordingOptions).recordingOptions).toEqual(recordingOptions);
  });
});
