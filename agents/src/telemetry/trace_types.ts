// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// LiveKit custom attributes
export const ATTR_SPEECH_ID = 'lk.speech_id';
export const ATTR_AGENT_LABEL = 'lk.agent_label';
export const ATTR_START_TIME = 'lk.start_time';
export const ATTR_END_TIME = 'lk.end_time';
export const ATTR_RETRY_COUNT = 'lk.retry_count';

export const ATTR_PARTICIPANT_ID = 'lk.participant_id';
export const ATTR_PARTICIPANT_IDENTITY = 'lk.participant_identity';
export const ATTR_PARTICIPANT_KIND = 'lk.participant_kind';

// session start
export const ATTR_JOB_ID = 'lk.job_id';
export const ATTR_AGENT_NAME = 'lk.agent_name';
export const ATTR_ROOM_NAME = 'lk.room_name';
export const ATTR_SESSION_OPTIONS = 'lk.session_options';

// assistant turn
export const ATTR_USER_INPUT = 'lk.user_input';
export const ATTR_INSTRUCTIONS = 'lk.instructions';
export const ATTR_SPEECH_INTERRUPTED = 'lk.interrupted';

// llm node
export const ATTR_CHAT_CTX = 'lk.chat_ctx';
export const ATTR_FUNCTION_TOOLS = 'lk.function_tools';
export const ATTR_RESPONSE_TEXT = 'lk.response.text';
export const ATTR_RESPONSE_FUNCTION_CALLS = 'lk.response.function_calls';

// function tool
export const ATTR_FUNCTION_TOOL_NAME = 'lk.function_tool.name';
export const ATTR_FUNCTION_TOOL_ARGS = 'lk.function_tool.arguments';
export const ATTR_FUNCTION_TOOL_IS_ERROR = 'lk.function_tool.is_error';
export const ATTR_FUNCTION_TOOL_OUTPUT = 'lk.function_tool.output';

// tts node
export const ATTR_TTS_INPUT_TEXT = 'lk.input_text';
export const ATTR_TTS_STREAMING = 'lk.tts.streaming';
export const ATTR_TTS_LABEL = 'lk.tts.label';

// eou detection
export const ATTR_EOU_PROBABILITY = 'lk.eou.probability';
export const ATTR_EOU_UNLIKELY_THRESHOLD = 'lk.eou.unlikely_threshold';
export const ATTR_EOU_DELAY = 'lk.eou.endpointing_delay';
export const ATTR_EOU_LANGUAGE = 'lk.eou.language';
export const ATTR_USER_TRANSCRIPT = 'lk.user_transcript';
export const ATTR_TRANSCRIPT_CONFIDENCE = 'lk.transcript_confidence';
export const ATTR_TRANSCRIPTION_DELAY = 'lk.transcription_delay';
export const ATTR_END_OF_TURN_DELAY = 'lk.end_of_turn_delay';

// metrics
export const ATTR_LLM_METRICS = 'lk.llm_metrics';
export const ATTR_TTS_METRICS = 'lk.tts_metrics';
export const ATTR_REALTIME_MODEL_METRICS = 'lk.realtime_model_metrics';

// OpenTelemetry GenAI attributes
// OpenTelemetry specification: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';

// Unofficial OpenTelemetry GenAI attributes, recognized by LangFuse
// https://langfuse.com/integrations/native/opentelemetry#usage
// but not yet in the official OpenTelemetry specification.
export const ATTR_GEN_AI_USAGE_INPUT_TEXT_TOKENS = 'gen_ai.usage.input_text_tokens';
export const ATTR_GEN_AI_USAGE_INPUT_AUDIO_TOKENS = 'gen_ai.usage.input_audio_tokens';
export const ATTR_GEN_AI_USAGE_INPUT_CACHED_TOKENS = 'gen_ai.usage.input_cached_tokens';
export const ATTR_GEN_AI_USAGE_OUTPUT_TEXT_TOKENS = 'gen_ai.usage.output_text_tokens';
export const ATTR_GEN_AI_USAGE_OUTPUT_AUDIO_TOKENS = 'gen_ai.usage.output_audio_tokens';

// OpenTelemetry GenAI event names (for structured logging)
export const EVENT_GEN_AI_SYSTEM_MESSAGE = 'gen_ai.system.message';
export const EVENT_GEN_AI_USER_MESSAGE = 'gen_ai.user.message';
export const EVENT_GEN_AI_ASSISTANT_MESSAGE = 'gen_ai.assistant.message';
export const EVENT_GEN_AI_TOOL_MESSAGE = 'gen_ai.tool.message';
export const EVENT_GEN_AI_CHOICE = 'gen_ai.choice';

// Exception attributes
export const ATTR_EXCEPTION_TRACE = 'exception.stacktrace';
export const ATTR_EXCEPTION_TYPE = 'exception.type';
export const ATTR_EXCEPTION_MESSAGE = 'exception.message';

// Platform-specific attributes
export const ATTR_LANGFUSE_COMPLETION_START_TIME = 'langfuse.observation.completion_start_time';
