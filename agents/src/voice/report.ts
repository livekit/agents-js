// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext } from '../llm/chat_context.js';
import type { VoiceOptions } from './agent_session.js';
import type { AgentEvent } from './events.js';

export interface SessionReport {
  jobId: string;
  roomId: string;
  room: string;
  options: VoiceOptions;
  events: AgentEvent[];
  chatHistory: ChatContext;
  enableRecording: boolean;
  /** Timestamp when the session started (milliseconds) */
  startedAt: number;
  /** Timestamp when the session report was created (milliseconds), typically at the end of the session */
  timestamp: number;
  /** Path to the audio recording file (if recording was enabled) */
  audioRecordingPath?: string;
  /** Timestamp when the audio recording started (milliseconds) */
  audioRecordingStartedAt?: number;
  /** Duration of the session in milliseconds */
  duration?: number;
}

export interface SessionReportOptions {
  jobId: string;
  roomId: string;
  room: string;
  options: VoiceOptions;
  events: AgentEvent[];
  chatHistory: ChatContext;
  enableRecording?: boolean;
  /** Timestamp when the session started (milliseconds) */
  startedAt?: number;
  /** Timestamp when the session report was created (milliseconds) */
  timestamp?: number;
  /** Path to the audio recording file (if recording was enabled) */
  audioRecordingPath?: string;
  /** Timestamp when the audio recording started (milliseconds) */
  audioRecordingStartedAt?: number;
}

export function createSessionReport(opts: SessionReportOptions): SessionReport {
  const timestamp = opts.timestamp ?? Date.now();
  const audioRecordingStartedAt = opts.audioRecordingStartedAt;

  return {
    jobId: opts.jobId,
    roomId: opts.roomId,
    room: opts.room,
    options: opts.options,
    events: opts.events,
    chatHistory: opts.chatHistory,
    enableRecording: opts.enableRecording ?? false,
    startedAt: opts.startedAt ?? Date.now(),
    timestamp,
    audioRecordingPath: opts.audioRecordingPath,
    audioRecordingStartedAt,
    duration:
      audioRecordingStartedAt !== undefined ? timestamp - audioRecordingStartedAt : undefined,
  };
}

//   - header: protobuf MetricsRecordingHeader (room_id, duration, start_time)
//   - chat_history: JSON serialized chat history (use sessionReportToJSON)
//   - audio: audio recording file if available (ogg format)
//   - Uploads to LiveKit Cloud observability endpoint with JWT auth
export function sessionReportToJSON(report: SessionReport): Record<string, unknown> {
  const events: Record<string, unknown>[] = [];

  for (const event of report.events) {
    if (event.type === 'metrics_collected') {
      continue; // metrics are too noisy, Cloud is using the chat_history as the source of truth
    }

    events.push({ ...event });
  }

  return {
    job_id: report.jobId,
    room_id: report.roomId,
    room: report.room,
    events,
    options: {
      allow_interruptions: report.options.allowInterruptions,
      discard_audio_if_uninterruptible: report.options.discardAudioIfUninterruptible,
      min_interruption_duration: report.options.minInterruptionDuration,
      min_interruption_words: report.options.minInterruptionWords,
      min_endpointing_delay: report.options.minEndpointingDelay,
      max_endpointing_delay: report.options.maxEndpointingDelay,
      max_tool_steps: report.options.maxToolSteps,
    },
    chat_history: report.chatHistory.toJSON({ excludeTimestamp: false }),
    enable_user_data_training: report.enableRecording,
    timestamp: report.timestamp,
  };
}
