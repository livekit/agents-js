// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Span attribute and event name constants for LiveKit Agents telemetry.
 *
 * Attributes carrying conversational content, tool payloads, or other user data must include a
 * dot-delimited `pii` segment (`lk.pii.<name>`). PII-enabled projects have these attributes
 * stripped at the LiveKit Cloud collector, and the segment is the marker it honors. Such content
 * must not be embedded in span names, event names, or log message bodies because those are not
 * redactable. For structured attributes, the collector applies the marker recursively to keys in
 * nested OTLP key-value lists and arrays.
 */

// LiveKit custom attributes
export const ATTR_SPEECH_ID = 'lk.speech_id';
export const ATTR_AGENT_LABEL = 'lk.agent_label';
export const ATTR_START_TIME = 'lk.start_time';
export const ATTR_END_TIME = 'lk.end_time';
export const ATTR_RETRY_COUNT = 'lk.retry_count';

/**
 * Provider-known correlation ids associated with this span (string[]).
 *
 * Populated by STT/TTS plugins when the id is either sent to the provider
 * (e.g. WS context_id) or returned by it (e.g. response request_id /
 * session_id), so it can be cross-referenced with the provider's logs for
 * debugging.
 */
export const ATTR_PROVIDER_REQUEST_IDS = 'lk.provider_request_ids';

export const ATTR_PARTICIPANT_ID = 'lk.participant_id';
export const ATTR_PARTICIPANT_IDENTITY = 'lk.pii.participant_identity';
export const ATTR_PARTICIPANT_KIND = 'lk.participant_kind';

// session start
export const ATTR_JOB_ID = 'lk.job_id';
export const ATTR_AGENT_NAME = 'lk.agent_name';
export const ATTR_CLOUD_AGENT_ID = 'lk.cloud_agent_id';
export const ATTR_DEPLOYMENT_ID = 'lk.deployment_id';
export const ATTR_ROOM_NAME = 'lk.pii.room_name';
export const ATTR_SESSION_OPTIONS = 'lk.session_options';

// assistant turn
export const ATTR_AGENT_TURN_ID = 'lk.generation_id';
export const ATTR_AGENT_PARENT_TURN_ID = 'lk.parent_generation_id';
export const ATTR_USER_INPUT = 'lk.pii.user_input';
export const ATTR_INSTRUCTIONS = 'lk.pii.instructions';
export const ATTR_SPEECH_INTERRUPTED = 'lk.interrupted';

// llm node
export const ATTR_CHAT_CTX = 'lk.pii.chat_ctx';
export const ATTR_FUNCTION_TOOLS = 'lk.function_tools';
export const ATTR_PROVIDER_TOOLS = 'lk.provider_tools';
export const ATTR_TOOL_SETS = 'lk.tool_sets';
export const ATTR_RESPONSE_TEXT = 'lk.pii.response.text';
export const ATTR_RESPONSE_FUNCTION_CALLS = 'lk.pii.response.function_calls';
/** Time to first token in seconds. */
export const ATTR_RESPONSE_TTFT = 'lk.response.ttft';

// function tool
export const ATTR_FUNCTION_TOOL_ID = 'lk.function_tool.id';
export const ATTR_FUNCTION_TOOL_NAME = 'lk.function_tool.name';
export const ATTR_FUNCTION_TOOL_ARGS = 'lk.pii.function_tool.arguments';
export const ATTR_FUNCTION_TOOL_IS_ERROR = 'lk.function_tool.is_error';
export const ATTR_FUNCTION_TOOL_OUTPUT = 'lk.pii.function_tool.output';

// tts node
export const ATTR_TTS_INPUT_TEXT = 'lk.pii.input_text';
export const ATTR_TTS_STREAMING = 'lk.tts.streaming';
export const ATTR_TTS_LABEL = 'lk.tts.label';
/** Time to first byte in seconds. */
export const ATTR_RESPONSE_TTFB = 'lk.response.ttfb';

// eou detection
export const ATTR_EOU_PROBABILITY = 'lk.eou.probability';
export const ATTR_EOU_UNLIKELY_THRESHOLD = 'lk.eou.unlikely_threshold';
export const ATTR_EOU_DELAY = 'lk.eou.endpointing_delay';
export const ATTR_EOU_LANGUAGE = 'lk.eou.language';
/** Which signal triggered the EOU detection: 'vad' | 'stt' | 'manual'. */
export const ATTR_EOU_SOURCE = 'lk.eou.source';
/** True when the audio EOT detector resolved this prediction from its
 * inference-window cache instead of running a fresh predict. */
export const ATTR_EOU_FROM_CACHE = 'lk.eou.from_cache';
/** Latest input-audio creation time → prediction receive time (ms). */
export const ATTR_EOU_DETECTION_DELAY = 'lk.eou.detection_delay';
export const ATTR_USER_TRANSCRIPT = 'lk.pii.user_transcript';
export const ATTR_TRANSCRIPT_CONFIDENCE = 'lk.transcript_confidence';
export const ATTR_TRANSCRIPTION_DELAY = 'lk.transcription_delay';
export const ATTR_END_OF_TURN_DELAY = 'lk.end_of_turn_delay';

// answering machine detection
export const ATTR_AMD_CATEGORY = 'lk.amd.category';
export const ATTR_AMD_REASON = 'lk.amd.reason';
export const ATTR_AMD_IS_MACHINE = 'lk.amd.is_machine';
export const ATTR_AMD_INTERRUPT_ON_MACHINE = 'lk.amd.interrupt_on_machine';
/** Total user-speech duration captured before the AMD verdict (milliseconds). */
export const ATTR_AMD_SPEECH_DURATION = 'lk.amd.speech_duration';
/** Time between speech end and the AMD verdict emission (milliseconds). */
export const ATTR_AMD_DELAY = 'lk.amd.delay';
export const ATTR_AMD_TRANSCRIPT = 'lk.pii.amd.transcript';

// Adaptive Interruption attributes
export const ATTR_IS_INTERRUPTION = 'lk.is_interruption';
export const ATTR_INTERRUPTION_PROBABILITY = 'lk.interruption.probability';
export const ATTR_INTERRUPTION_TOTAL_DURATION = 'lk.interruption.total_duration';
export const ATTR_INTERRUPTION_PREDICTION_DURATION = 'lk.interruption.prediction_duration';
export const ATTR_INTERRUPTION_DETECTION_DELAY = 'lk.interruption.detection_delay';

// metrics
export const ATTR_LLM_METRICS = 'lk.llm_metrics';
export const ATTR_TTS_METRICS = 'lk.tts_metrics';
export const ATTR_REALTIME_MODEL_METRICS = 'lk.realtime_model_metrics';

/** End-to-end latency in seconds. */
export const ATTR_E2E_LATENCY = 'lk.e2e_latency';

// OpenTelemetry GenAI semantic conventions, mirroring the attribute registry of
// https://github.com/open-telemetry/semantic-conventions-genai. Backends ingest these
// directly, so the names must stay byte-for-byte identical to the registry. The ones the
// spec flags as sensitive are listed in GEN_AI_PII_ATTRIBUTES in ./pii.ts, since a
// standard name cannot carry the `lk.pii.` marker segment.

export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const ATTR_GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';

export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const ATTR_GEN_AI_REQUEST_MAX_TOKENS = 'gen_ai.request.max_tokens';
export const ATTR_GEN_AI_REQUEST_CHOICE_COUNT = 'gen_ai.request.choice.count';
export const ATTR_GEN_AI_REQUEST_TEMPERATURE = 'gen_ai.request.temperature';
export const ATTR_GEN_AI_REQUEST_TOP_P = 'gen_ai.request.top_p';
export const ATTR_GEN_AI_REQUEST_TOP_K = 'gen_ai.request.top_k';
export const ATTR_GEN_AI_REQUEST_STOP_SEQUENCES = 'gen_ai.request.stop_sequences';
export const ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY = 'gen_ai.request.frequency_penalty';
export const ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY = 'gen_ai.request.presence_penalty';
export const ATTR_GEN_AI_REQUEST_ENCODING_FORMATS = 'gen_ai.request.encoding_formats';
export const ATTR_GEN_AI_REQUEST_SEED = 'gen_ai.request.seed';
export const ATTR_GEN_AI_REQUEST_STREAM = 'gen_ai.request.stream';
export const ATTR_GEN_AI_REQUEST_REASONING_LEVEL = 'gen_ai.request.reasoning.level';
export const ATTR_GEN_AI_REQUEST_PREVIOUS_RESPONSE_ID = 'gen_ai.request.previous_response.id';
export const ATTR_GEN_AI_REQUEST_STREAM_CURSOR = 'gen_ai.request.stream_cursor';

export const ATTR_GEN_AI_RESPONSE_ID = 'gen_ai.response.id';
export const ATTR_GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
export const ATTR_GEN_AI_RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons';
export const ATTR_GEN_AI_RESPONSE_STATUS = 'gen_ai.response.status';
/** Time to first chunk of a streaming response, in seconds. */
export const ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK = 'gen_ai.response.time_to_first_chunk';

export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens';
export const ATTR_GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS = 'gen_ai.usage.cache_write.input_tokens';
export const ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS = 'gen_ai.usage.reasoning.output_tokens';
export const ATTR_GEN_AI_USAGE_TEXT_INPUT_TOKENS = 'gen_ai.usage.text.input_tokens';
export const ATTR_GEN_AI_USAGE_TEXT_OUTPUT_TOKENS = 'gen_ai.usage.text.output_tokens';
export const ATTR_GEN_AI_USAGE_TEXT_CACHE_READ_INPUT_TOKENS =
  'gen_ai.usage.text.cache_read.input_tokens';
export const ATTR_GEN_AI_USAGE_AUDIO_INPUT_TOKENS = 'gen_ai.usage.audio.input_tokens';
export const ATTR_GEN_AI_USAGE_AUDIO_OUTPUT_TOKENS = 'gen_ai.usage.audio.output_tokens';
export const ATTR_GEN_AI_USAGE_AUDIO_CACHE_READ_INPUT_TOKENS =
  'gen_ai.usage.audio.cache_read.input_tokens';
export const ATTR_GEN_AI_USAGE_IMAGE_INPUT_TOKENS = 'gen_ai.usage.image.input_tokens';
export const ATTR_GEN_AI_USAGE_IMAGE_OUTPUT_TOKENS = 'gen_ai.usage.image.output_tokens';
export const ATTR_GEN_AI_USAGE_IMAGE_CACHE_READ_INPUT_TOKENS =
  'gen_ai.usage.image.cache_read.input_tokens';
export const ATTR_GEN_AI_TOKEN_TYPE = 'gen_ai.token.type';

export const ATTR_GEN_AI_CONVERSATION_ID = 'gen_ai.conversation.id';
export const ATTR_GEN_AI_CONVERSATION_COMPACTED = 'gen_ai.conversation.compacted';

export const ATTR_GEN_AI_AGENT_ID = 'gen_ai.agent.id';
export const ATTR_GEN_AI_AGENT_NAME = 'gen_ai.agent.name';
export const ATTR_GEN_AI_AGENT_DESCRIPTION = 'gen_ai.agent.description';
export const ATTR_GEN_AI_AGENT_VERSION = 'gen_ai.agent.version';

export const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
export const ATTR_GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call.id';
export const ATTR_GEN_AI_TOOL_DESCRIPTION = 'gen_ai.tool.description';
export const ATTR_GEN_AI_TOOL_TYPE = 'gen_ai.tool.type';
export const ATTR_GEN_AI_TOOL_CALL_ARGUMENTS = 'gen_ai.tool.call.arguments';
export const ATTR_GEN_AI_TOOL_CALL_RESULT = 'gen_ai.tool.call.result';
export const ATTR_GEN_AI_TOOL_DEFINITIONS = 'gen_ai.tool.definitions';

export const ATTR_GEN_AI_SYSTEM_INSTRUCTIONS = 'gen_ai.system_instructions';
export const ATTR_GEN_AI_INPUT_MESSAGES = 'gen_ai.input.messages';
export const ATTR_GEN_AI_OUTPUT_MESSAGES = 'gen_ai.output.messages';
export const ATTR_GEN_AI_OUTPUT_TYPE = 'gen_ai.output.type';

export const ATTR_GEN_AI_DATA_SOURCE_ID = 'gen_ai.data_source.id';
export const ATTR_GEN_AI_EMBEDDINGS_DIMENSION_COUNT = 'gen_ai.embeddings.dimension.count';
export const ATTR_GEN_AI_RETRIEVAL_DOCUMENTS = 'gen_ai.retrieval.documents';
export const ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT = 'gen_ai.retrieval.query.text';
export const ATTR_GEN_AI_RETRIEVAL_TOP_K = 'gen_ai.retrieval.top_k';
export const ATTR_GEN_AI_MEMORY_STORE_ID = 'gen_ai.memory.store.id';
export const ATTR_GEN_AI_MEMORY_RECORD_ID = 'gen_ai.memory.record.id';
export const ATTR_GEN_AI_MEMORY_RECORD_COUNT = 'gen_ai.memory.record.count';
export const ATTR_GEN_AI_MEMORY_QUERY_TEXT = 'gen_ai.memory.query.text';
export const ATTR_GEN_AI_MEMORY_RECORDS = 'gen_ai.memory.records';
export const ATTR_GEN_AI_EVALUATION_NAME = 'gen_ai.evaluation.name';
export const ATTR_GEN_AI_EVALUATION_SCORE_VALUE = 'gen_ai.evaluation.score.value';
export const ATTR_GEN_AI_EVALUATION_SCORE_LABEL = 'gen_ai.evaluation.score.label';
export const ATTR_GEN_AI_EVALUATION_EXPLANATION = 'gen_ai.evaluation.explanation';
export const ATTR_GEN_AI_PROMPT_NAME = 'gen_ai.prompt.name';
export const ATTR_GEN_AI_PROMPT_VERSION = 'gen_ai.prompt.version';
/** Template attribute: the concrete key is `gen_ai.prompt.variable.<name>`. */
export const ATTR_GEN_AI_PROMPT_VARIABLE = 'gen_ai.prompt.variable';
export const ATTR_GEN_AI_WORKFLOW_NAME = 'gen_ai.workflow.name';

export const ATTR_ERROR_TYPE = 'error.type';
export const ATTR_SERVER_ADDRESS = 'server.address';
export const ATTR_SERVER_PORT = 'server.port';

/** Well-known `gen_ai.operation.name` values. */
export const GenAIOperationName = {
  CHAT: 'chat',
  GENERATE_CONTENT: 'generate_content',
  TEXT_COMPLETION: 'text_completion',
  EMBEDDINGS: 'embeddings',
  RETRIEVAL: 'retrieval',
  FETCH_RESPONSE: 'fetch_response',
  CREATE_AGENT: 'create_agent',
  INVOKE_AGENT: 'invoke_agent',
  EXECUTE_TOOL: 'execute_tool',
  INVOKE_WORKFLOW: 'invoke_workflow',
  PLAN: 'plan',
  SEARCH_MEMORY: 'search_memory',
  CREATE_MEMORY: 'create_memory',
  UPDATE_MEMORY: 'update_memory',
  UPSERT_MEMORY: 'upsert_memory',
  DELETE_MEMORY: 'delete_memory',
  CREATE_MEMORY_STORE: 'create_memory_store',
  DELETE_MEMORY_STORE: 'delete_memory_store',
} as const;

/** Well-known `gen_ai.output.type` values. */
export const GenAIOutputType = {
  TEXT: 'text',
  JSON: 'json',
  IMAGE: 'image',
  SPEECH: 'speech',
} as const;

/** Well-known `gen_ai.response.finish_reasons` values. */
export const GenAIFinishReason = {
  STOP: 'stop',
  LENGTH: 'length',
  CONTENT_FILTER: 'content_filter',
  TOOL_CALL: 'tool_call',
  COMPACTION: 'compaction',
  ERROR: 'error',
} as const;

/**
 * The `gen_ai.provider.name` values the registry enumerates.
 *
 * For a provider on this list the convention says the registry spelling MUST be used, since
 * backends treat the attribute as the discriminator for provider-specific parsing. A provider
 * that is not on it MAY report a custom value, so those pass through untouched.
 */
export const GEN_AI_PROVIDER_NAMES: ReadonlySet<string> = new Set([
  'openai',
  'gcp.gen_ai',
  'gcp.vertex_ai',
  'gcp.gemini',
  'anthropic',
  'cohere',
  'azure.ai.inference',
  'azure.ai.openai',
  'ibm.watsonx.ai',
  'aws.bedrock',
  'perplexity',
  'x_ai',
  'deepseek',
  'groq',
  'mistral_ai',
  'moonshot_ai',
]);

// Plugins report `provider` either as a display name ('AWS Bedrock', 'MistralAI') or, for the
// OpenAI-compatible clients, as the base URL's host ('api.mistral.ai'). Both are mapped here:
// by host first, then by the display name reduced to lowercase alphanumerics, so
// 'AWS Bedrock' / 'aws_bedrock' / 'awsbedrock' all resolve alike.
const PROVIDER_BY_HOST: Record<string, string> = {
  'api.anthropic.com': 'anthropic',
  'api.cohere.ai': 'cohere',
  'api.cohere.com': 'cohere',
  'api.deepseek.com': 'deepseek',
  'api.groq.com': 'groq',
  'api.mistral.ai': 'mistral_ai',
  'api.moonshot.ai': 'moonshot_ai',
  'api.moonshot.cn': 'moonshot_ai',
  'api.openai.com': 'openai',
  'api.perplexity.ai': 'perplexity',
  'api.x.ai': 'x_ai',
  'generativelanguage.googleapis.com': 'gcp.gemini',
};

const PROVIDER_BY_HOST_SUFFIX: readonly [string, string][] = [
  ['.openai.azure.com', 'azure.ai.openai'],
  ['.services.ai.azure.com', 'azure.ai.inference'],
  ['.aiplatform.googleapis.com', 'gcp.vertex_ai'],
  ['.amazonaws.com', 'aws.bedrock'],
];

const PROVIDER_BY_NAME: Record<string, string> = {
  amazonbedrock: 'aws.bedrock',
  anthropic: 'anthropic',
  awsbedrock: 'aws.bedrock',
  azureaiinference: 'azure.ai.inference',
  azureopenai: 'azure.ai.openai',
  bedrock: 'aws.bedrock',
  cohere: 'cohere',
  deepseek: 'deepseek',
  gemini: 'gcp.gemini',
  google: 'gcp.gen_ai',
  googlecloudplatform: 'gcp.gen_ai',
  googlegenai: 'gcp.gen_ai',
  groq: 'groq',
  ibmwatsonxai: 'ibm.watsonx.ai',
  mistral: 'mistral_ai',
  mistralai: 'mistral_ai',
  moonshot: 'moonshot_ai',
  moonshotai: 'moonshot_ai',
  openai: 'openai',
  perplexity: 'perplexity',
  vertexai: 'gcp.vertex_ai',
  vertexaimodelgarden: 'gcp.vertex_ai',
  watsonx: 'ibm.watsonx.ai',
  xai: 'x_ai',
};

/** Normalize a LiveKit plugin's `provider` to its GenAI registry spelling. */
export function genAIProviderName(provider: string | undefined | null): string | undefined {
  const value = provider?.trim();
  if (!value) return undefined;

  const host = value.toLowerCase();
  if (PROVIDER_BY_HOST[host]) return PROVIDER_BY_HOST[host];
  for (const [suffix, mapped] of PROVIDER_BY_HOST_SUFFIX) {
    if (host.endsWith(suffix)) return mapped;
  }

  const canonical = host.replace(/[^a-z0-9]/g, '');
  // a provider outside the registry keeps its own id, which the convention allows
  return PROVIDER_BY_NAME[canonical] ?? value;
}

/** @internal Exposed for the guard test that walks the plugins' provider values. */
export const _providerTables = {
  byHost: PROVIDER_BY_HOST,
  byHostSuffix: PROVIDER_BY_HOST_SUFFIX,
  byName: PROVIDER_BY_NAME,
};

// Unofficial OpenTelemetry GenAI attributes, recognized by LangFuse
// https://langfuse.com/integrations/native/opentelemetry#usage
// but not in the official OpenTelemetry specification. Emitted alongside the official
// `gen_ai.usage.*.{input,output}_tokens` names above.
export const ATTR_GEN_AI_USAGE_INPUT_TEXT_TOKENS = 'gen_ai.usage.input_text_tokens';
export const ATTR_GEN_AI_USAGE_INPUT_AUDIO_TOKENS = 'gen_ai.usage.input_audio_tokens';
export const ATTR_GEN_AI_USAGE_INPUT_CACHED_TOKENS = 'gen_ai.usage.input_cached_tokens';
export const ATTR_GEN_AI_USAGE_OUTPUT_TEXT_TOKENS = 'gen_ai.usage.output_text_tokens';
export const ATTR_GEN_AI_USAGE_OUTPUT_AUDIO_TOKENS = 'gen_ai.usage.output_audio_tokens';
export const ATTR_GEN_AI_USAGE_REASONING_TOKENS = 'gen_ai.usage.reasoning_tokens';

// OpenTelemetry GenAI event names (for structured logging)
export const EVENT_GEN_AI_SYSTEM_MESSAGE = 'gen_ai.system.message';
export const EVENT_GEN_AI_USER_MESSAGE = 'gen_ai.user.message';
export const EVENT_GEN_AI_ASSISTANT_MESSAGE = 'gen_ai.assistant.message';
export const EVENT_GEN_AI_TOOL_MESSAGE = 'gen_ai.tool.message';
export const EVENT_GEN_AI_CHOICE = 'gen_ai.choice';
export const EVENT_GEN_AI_CLIENT_INFERENCE_OPERATION_DETAILS =
  'gen_ai.client.inference.operation.details';

// OpenTelemetry GenAI metric names
export const METRIC_GEN_AI_CLIENT_TOKEN_USAGE = 'gen_ai.client.token.usage';
export const METRIC_GEN_AI_CLIENT_OPERATION_DURATION = 'gen_ai.client.operation.duration';
export const METRIC_GEN_AI_CLIENT_TIME_TO_FIRST_CHUNK =
  'gen_ai.client.operation.time_to_first_chunk';
export const METRIC_GEN_AI_CLIENT_TIME_PER_OUTPUT_CHUNK =
  'gen_ai.client.operation.time_per_output_chunk';
export const METRIC_GEN_AI_INVOKE_AGENT_DURATION = 'gen_ai.invoke_agent.duration';
export const METRIC_GEN_AI_INVOKE_AGENT_INFERENCE_CALLS = 'gen_ai.invoke_agent.inference_calls';
export const METRIC_GEN_AI_INVOKE_AGENT_TOOL_CALLS = 'gen_ai.invoke_agent.tool_calls';
export const METRIC_GEN_AI_EXECUTE_TOOL_DURATION = 'gen_ai.execute_tool.duration';

// Exception attributes
export const ATTR_EXCEPTION_TRACE = 'exception.stacktrace';
export const ATTR_EXCEPTION_TYPE = 'exception.type';
export const ATTR_EXCEPTION_MESSAGE = 'exception.message';

// Platform-specific attributes
export const ATTR_LANGFUSE_COMPLETION_START_TIME = 'langfuse.observation.completion_start_time';
