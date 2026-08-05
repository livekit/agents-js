// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { ChatContext } from '../llm/chat_context.js';
import { type ModelUsage, filterZeroValues } from '../metrics/model_usage.js';
import { version } from '../version.js';
import type {
  AgentSessionOptions,
  ResolvedRecordingOptions,
  VoiceOptions,
} from './agent_session.js';
import type { AgentEvent } from './events.js';

type ReportOptions = AgentSessionOptions & Partial<VoiceOptions>;

export interface SessionReport {
  jobId: string;
  roomId: string;
  room: string;
  options: ReportOptions;
  events: AgentEvent[];
  chatHistory: ChatContext;
  enableRecording: boolean;
  /** Resolved per-category recording options for this session. */
  recordingOptions: ResolvedRecordingOptions;
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
  /** Usage summaries for the session, one per model/provider combination */
  modelUsage?: ModelUsage[];
}

export interface SessionReportOptions {
  jobId: string;
  roomId: string;
  room: string;
  options: ReportOptions;
  events: AgentEvent[];
  chatHistory: ChatContext;
  enableRecording?: boolean;
  /** Resolved per-category recording options for this session. */
  recordingOptions?: ResolvedRecordingOptions;
  /** Timestamp when the session started (milliseconds) */
  startedAt?: number;
  /** Timestamp when the session report was created (milliseconds) */
  timestamp?: number;
  /** Path to the audio recording file (if recording was enabled) */
  audioRecordingPath?: string;
  /** Timestamp when the audio recording started (milliseconds) */
  audioRecordingStartedAt?: number;
  /** Usage summaries for the session, one per model/provider combination */
  modelUsage?: ModelUsage[];
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
    recordingOptions: opts.recordingOptions ?? {
      audio: false,
      traces: false,
      logs: false,
      transcript: false,
      redaction: false,
    },
    startedAt: opts.startedAt ?? Date.now(),
    timestamp,
    audioRecordingPath: opts.audioRecordingPath,
    audioRecordingStartedAt,
    duration:
      audioRecordingStartedAt !== undefined ? timestamp - audioRecordingStartedAt : undefined,
    modelUsage: opts.modelUsage,
  };
}

/**
 * Field renames that are not pure case conversions. The chat-item `toJSON()` methods emit the
 * framework's native (camelCase) field names; a few of those differ from the Python wire field
 * name beyond casing (e.g. `FunctionCall.args` is serialized as `arguments`).
 */
/**
 * Convert a camelCase key to its wire name (snake_case, e.g. `oldState` becomes `old_state`,
 * `e2eLatency` becomes `e2e_latency`). `args` is special-cased to `arguments` — the chat-item
 * `toJSON()` methods emit the framework's native `args`, but the Python wire field is `arguments`.
 */
function jsToPythonFieldName(key: string): string {
  if (key === 'args') {
    return 'arguments';
  }
  return key.replace(/([A-Z]+)/g, (m) => `_${m.toLowerCase()}`);
}

/**
 * Recursively convert object keys to snake_case so the emitted wire format matches the
 * Python framework (whose pydantic models serialize with snake_case field names, no alias).
 * Objects exposing `toJSON()` (chat items, content) emit the framework's native camelCase shape,
 * so their output is recursed into here rather than trusted. Arrays are mapped; primitives pass
 * through; `extra` dicts are emitted verbatim (Python keeps `extra` as a free-form dict, so its
 * provider-supplied keys must not be converted).
 *
 * @internal Exported so other Python-facing serialization boundaries (e.g. the `lk.pii.chat_ctx`
 * span attribute) can emit the same snake_case wire shape as the session report.
 */
export function toSnakeCaseDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toSnakeCaseDeep);
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return toSnakeCaseDeep((value as { toJSON: () => unknown }).toJSON());
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) {
      continue;
    }
    out[jsToPythonFieldName(k)] = k === 'extra' ? v : toSnakeCaseDeep(v);
  }
  return out;
}

/** Serialize an error event `source` (LLM/STT/TTS/RealtimeModel) like Python's field_serializer. */
function serializeEventSource(source: unknown): unknown {
  if (source && typeof source === 'object') {
    const s = source as { model?: unknown; provider?: unknown };
    if ('model' in s || 'provider' in s) {
      return { model: s.model ?? null, provider: s.provider ?? null };
    }
  }
  return source === undefined ? null : String(source);
}

/** Serialize an error event `error` like Python's field_serializer (BaseModel becomes dict, else repr). */
function serializeEventError(error: unknown): unknown {
  if (error === null || error === undefined) {
    return null;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object') {
    return toSnakeCaseDeep(error);
  }
  return error;
}

/**
 * Serialize an AgentEvent to its snake_case wire form, matching Python's `event.model_dump()`.
 * Non-serializable handles (`speechHandle`, raw audio) are dropped, and error/source objects are
 * reduced the same way the Python field serializers do.
 */
function eventToJSON(event: AgentEvent): Record<string, unknown> {
  const e: Record<string, unknown> = { ...(event as unknown as Record<string, unknown>) };

  switch (event.type) {
    case 'speech_created':
      // The Python SpeechCreatedEvent excludes the speech handle from serialization.
      delete e.speechHandle;
      break;
    case 'overlapping_speech':
      // Raw PCM is not part of the wire format.
      delete e.speechInput;
      break;
    case 'error':
      e.source = serializeEventSource(e.source);
      e.error = serializeEventError(e.error);
      break;
    case 'close':
      e.error = serializeEventError(e.error);
      break;
  }

  return toSnakeCaseDeep(e) as Record<string, unknown>;
}

/**
 * Serialize a single ModelUsage to snake_case, dropping zero-valued fields (matches Python's
 * `model_dump(exclude_defaults=True)`). Duration fields are emitted in seconds under their Python
 * names (`session_duration`, `audio_duration`) — the proto wire format and Python model both use
 * seconds for these durations, so the milliseconds stored on the JS side are converted here.
 */
function modelUsageToJSON(usage: ModelUsage): Record<string, unknown> {
  const filtered = filterZeroValues(usage) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filtered)) {
    if (v === undefined) {
      continue;
    }
    if (k === 'sessionDurationMs') {
      out.session_duration = (v as number) / 1000;
    } else if (k === 'audioDurationMs') {
      out.audio_duration = (v as number) / 1000;
    } else {
      out[jsToPythonFieldName(k)] = v;
    }
  }
  return out;
}

//   - header: protobuf MetricsRecordingHeader (room_id, duration, start_time)
//   - chat_history: JSON serialized chat history (use sessionReportToJSON)
//   - audio: audio recording file if available (ogg format)
//   - Uploads to LiveKit Cloud observability endpoint with JWT auth
export function sessionReportToJSON(report: SessionReport): Record<string, unknown> {
  const events: Record<string, unknown>[] = [];
  const options = report.options;
  const interruptionConfig = options.turnHandling?.interruption;
  const endpointingConfig = options.turnHandling?.endpointing;

  // Keep backwards compatibility with deprecated fields
  const allowInterruptions =
    interruptionConfig?.enabled !== undefined
      ? interruptionConfig.enabled
      : interruptionConfig?.mode !== undefined
        ? true
        : options.allowInterruptions ?? options.voiceOptions?.allowInterruptions;
  const discardAudioIfUninterruptible =
    interruptionConfig?.discardAudioIfUninterruptible ??
    options.discardAudioIfUninterruptible ??
    options.voiceOptions?.discardAudioIfUninterruptible;
  const minInterruptionDuration =
    interruptionConfig?.minDuration ??
    options.minInterruptionDuration ??
    options.voiceOptions?.minInterruptionDuration;
  const minInterruptionWords =
    interruptionConfig?.minWords ??
    options.minInterruptionWords ??
    options.voiceOptions?.minInterruptionWords;
  const minEndpointingDelay =
    endpointingConfig?.minDelay ??
    options.minEndpointingDelay ??
    options.voiceOptions?.minEndpointingDelay;
  const maxEndpointingDelay =
    endpointingConfig?.maxDelay ??
    options.maxEndpointingDelay ??
    options.voiceOptions?.maxEndpointingDelay;

  for (const event of report.events) {
    if (event.type === 'metrics_collected' || event.type === 'session_usage_updated') {
      continue; // metrics are too noisy, Cloud is using the chat_history as the source of truth
    }

    events.push(eventToJSON(event));
  }

  return {
    job_id: report.jobId,
    room_id: report.roomId,
    room: report.room,
    events,
    audio_recording_path: report.audioRecordingPath ?? null,
    audio_recording_started_at: report.audioRecordingStartedAt ?? null,
    options: {
      allow_interruptions: allowInterruptions,
      discard_audio_if_uninterruptible: discardAudioIfUninterruptible,
      min_interruption_duration: minInterruptionDuration,
      min_interruption_words: minInterruptionWords,
      min_endpointing_delay: minEndpointingDelay,
      max_endpointing_delay: maxEndpointingDelay,
      max_tool_steps: options.maxToolSteps,
      user_away_timeout: options.userAwayTimeout ?? null,
      preemptive_generation: options.turnHandling?.preemptiveGeneration ?? {},
    },
    chat_history: toSnakeCaseDeep(report.chatHistory.toJSON({ excludeTimestamp: false })),
    enable_user_data_training: report.enableRecording,
    timestamp: report.timestamp,
    usage: report.modelUsage ? report.modelUsage.map(modelUsageToJSON) : null,
    sdk_version: version,
  };
}
