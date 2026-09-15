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

// join keys shared with the server, SIP, and client traces
export const ATTR_ROOM_SID = 'lk.room_sid';
export const ATTR_DISPATCH_ID = 'lk.dispatch_id';
export const ATTR_WORKER_ID = 'lk.job.worker_id';
export const ATTR_JOB_AGENT_ID = 'lk.job.agent_id';
/**
 * Prefix under which a linked SIP participant's `sip.*` attributes are copied (call id, trunk
 * id and number, rule id, hostname, status, headers).
 */
export const ATTR_SIP_PREFIX = 'lk.sip.';
/** The end user's phone number (`sip.phoneNumber`), the one SIP attribute that is PII. */
export const ATTR_SIP_PHONE_NUMBER = 'lk.pii.sip.phoneNumber';

// job dispatch timeline (job_entrypoint). The stage instants are timestamped events
// (job_received, job_accepted, job_assigned, process_assigned, entrypoint_started); these
// attributes are the seconds between adjacent stages, so the chain reads off the span without
// timestamp arithmetic. They sum to the dispatch latency.
/** Seconds from the availability request to the worker's accept (the request handler). */
export const ATTR_JOB_ACCEPT_LATENCY = 'lk.job.accept_latency';
/** Seconds from the accept to the server's assignment (a server round trip). */
export const ATTR_JOB_ASSIGNMENT_LATENCY = 'lk.job.assignment_latency';
/** Seconds from the assignment to a process taking the job (pool acquisition). */
export const ATTR_JOB_LAUNCH_LATENCY = 'lk.job.launch_latency';
/** Seconds from the process taking the job to the user entrypoint running in it. */
export const ATTR_JOB_ENTRYPOINT_LATENCY = 'lk.job.entrypoint_latency';
/** Seconds from the availability request to the entrypoint running: the whole chain. */
export const ATTR_JOB_DISPATCH_LATENCY = 'lk.job.dispatch_latency';

// keyterm detection (keyterm_detection span): counts only, the terms themselves are the
// customer's vocabulary and travel as lk.pii.keyterms in the session report
/** Keyterms in effect after the pass (static + confirmed). */
export const ATTR_KEYTERMS_COUNT = 'lk.keyterms.count';
export const ATTR_KEYTERMS_ADDED = 'lk.keyterms.added';
export const ATTR_KEYTERMS_REMOVED = 'lk.keyterms.removed';

// room connect / room io
export const ATTR_ROOM_AUTO_SUBSCRIBE = 'lk.room.auto_subscribe';
export const ATTR_ROOM_E2EE = 'lk.room.e2ee';
export const ATTR_ROOM_REMOTE_PARTICIPANT_COUNT = 'lk.room.remote_participant_count';
/** Whether RoomIO waited for a specific participant identity (true) or the first eligible one. */
export const ATTR_ROOM_IO_PARTICIPANT_FILTER = 'lk.room_io.participant_filter';
export const ATTR_TRACK_SID = 'lk.track_sid';
export const ATTR_TRACK_SOURCE = 'lk.track_source';
/** Seconds from linking the participant to the first media frame received from them. */
export const ATTR_FIRST_FRAME_DELAY = 'lk.first_frame_delay';
export const ATTR_PRE_CONNECT_AUDIO_DURATION = 'lk.pre_connect_audio.duration';
export const ATTR_CONNECTION_STATE = 'lk.connection_state';
export const ATTR_DISCONNECT_REASON = 'lk.disconnect_reason';
export const ATTR_OLD_STATE = 'lk.old_state';
export const ATTR_NEW_STATE = 'lk.new_state';

// rpc (`rpc.method` from the OpenTelemetry RPC semantic conventions, plus lk.rpc.* details)
export const ATTR_RPC_METHOD = 'rpc.method';
export const ATTR_RPC_REQUEST_ID = 'lk.rpc.request_id';
export const ATTR_RPC_CALLER_IDENTITY = 'lk.rpc.caller_identity';
export const ATTR_RPC_DESTINATION_IDENTITY = 'lk.rpc.destination_identity';
/** Request payload, truncated to `telemetry.rpc.MAX_PAYLOAD_ATTR_LEN` characters. */
export const ATTR_RPC_PAYLOAD = 'lk.pii.rpc.payload';
/** Request payload size in bytes, before truncation. */
export const ATTR_RPC_PAYLOAD_SIZE = 'lk.rpc.payload_size';
/** Response payload, truncated like the request. */
export const ATTR_RPC_RESPONSE = 'lk.pii.rpc.response';
/** Response payload size in bytes, before truncation. */
export const ATTR_RPC_RESPONSE_SIZE = 'lk.rpc.response_size';
/** Seconds the caller waits for a response. */
export const ATTR_RPC_RESPONSE_TIMEOUT = 'lk.rpc.response_timeout';
/** The `RpcError` code the call failed with. */
export const ATTR_RPC_ERROR_CODE = 'lk.rpc.error_code';

// session close / job shutdown
export const ATTR_CLOSE_REASON = 'lk.close_reason';
export const ATTR_CLOSE_DRAIN = 'lk.close.drain';
/** The string passed to `JobContext.shutdown(reason)`; developer-authored, like a log line. */
export const ATTR_SHUTDOWN_REASON = 'lk.shutdown.reason';
export const ATTR_SHUTDOWN_USER_INITIATED = 'lk.shutdown.user_initiated';
export const ATTR_CALLBACK_NAME = 'lk.callback.name';

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
/** The endpointing delay in force for the turn, in seconds. */
export const ATTR_EOU_DELAY = 'lk.eou.endpointing_delay';
export const ATTR_EOU_LANGUAGE = 'lk.eou.language';
/** Which signal triggered the EOU detection: 'vad' | 'stt' | 'manual'. */
export const ATTR_EOU_SOURCE = 'lk.eou.source';
/** True when the audio EOT detector resolved this prediction from its
 * inference-window cache instead of running a fresh predict. */
export const ATTR_EOU_FROM_CACHE = 'lk.eou.from_cache';
/** Latest input-audio creation time → prediction receive time, in seconds. */
export const ATTR_EOU_DETECTION_DELAY = 'lk.eou.detection_delay';
// eou_wait span: from the user's last speech to the turn decision
/** How the wait ended: `committed`, `user_resumed`, or `dropped`. */
export const ATTR_EOU_OUTCOME = 'lk.eou.outcome';
/** Seconds from the end of the user's speech to the turn decision. */
export const ATTR_EOU_WAIT_DURATION = 'lk.eou.wait_duration';
/** Times the endpointing wait restarted on a later trigger (late transcript, VAD). */
export const ATTR_EOU_REARM_COUNT = 'lk.eou.rearm_count';
/** Turn decisions the wait rejected (the detector said the user was not done) before it ended. */
export const ATTR_EOU_NOT_COMMITTED_COUNT = 'lk.eou.not_committed_count';
/** On user_turn: endpointing waits the user cut short by speaking again. */
export const ATTR_EOU_RESUME_COUNT = 'lk.eou.resume_count';
/** Seconds the onUserTurnCompleted hook took; on the reply's agent_turn with the other stages. */
export const ATTR_ON_USER_TURN_COMPLETED_DELAY = 'lk.on_user_turn_completed_delay';

// speech scheduling
/** Seconds a speech handle waited in the queue before generation was authorized. */
export const ATTR_SPEECH_QUEUE_WAIT = 'lk.speech.queue_wait';
export const ATTR_USER_TRANSCRIPT = 'lk.pii.user_transcript';
export const ATTR_TRANSCRIPT_CONFIDENCE = 'lk.transcript_confidence';
/** Seconds from the end of the user's speech to the final transcript. */
export const ATTR_TRANSCRIPTION_DELAY = 'lk.transcription_delay';
/** Seconds from the end of the user's speech to the end-of-turn decision. */
export const ATTR_END_OF_TURN_DELAY = 'lk.end_of_turn_delay';

// answering machine detection
export const ATTR_AMD_CATEGORY = 'lk.amd.category';
export const ATTR_AMD_REASON = 'lk.amd.reason';
export const ATTR_AMD_IS_MACHINE = 'lk.amd.is_machine';
export const ATTR_AMD_INTERRUPT_ON_MACHINE = 'lk.amd.interrupt_on_machine';
/** Total user-speech duration captured before the AMD verdict, in seconds. */
export const ATTR_AMD_SPEECH_DURATION = 'lk.amd.speech_duration';
/** Time between speech end and the AMD verdict emission, in seconds. */
export const ATTR_AMD_DELAY = 'lk.amd.delay';
export const ATTR_AMD_TRANSCRIPT = 'lk.pii.amd.transcript';

// Interruptions (agent_turn)
/**
 * What interrupted the speech: `audio_activity` (barge-in), `user_turn` (a committed turn
 * preempting the reply), or `programmatic` (session.interrupt(), a tool, teardown).
 */
export const ATTR_INTERRUPTION_SOURCE = 'lk.interruption.source';
/** Seconds of audio that had actually played when the speech was interrupted. */
export const ATTR_PLAYOUT_POSITION = 'lk.playout.position';

// Agent handoff (update_agent span)
export const ATTR_PREVIOUS_AGENT_LABEL = 'lk.previous_agent_label';

// Fallback adapters (the attempt span)
/** Label of the provider that served the request. */
export const ATTR_FALLBACK_LABEL = 'lk.fallback.label';
export const ATTR_FALLBACK_INDEX = 'lk.fallback.index';

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

// Event loop blocking
/** Heartbeat lag in seconds. */
export const ATTR_BLOCKING_DURATION = 'lk.blocking.duration';
export const ATTR_BLOCKING_THRESHOLD = 'lk.blocking.threshold';
export const ATTR_BLOCKING_SEVERITY = 'lk.blocking.severity';
/** `code` for synchronous work on the loop, `host` when the process itself was not scheduled. */
export const ATTR_BLOCKING_CAUSE = 'lk.blocking.cause';
/** Not populated by the Node runtime: it cannot sample another thread's JavaScript stack. */
export const ATTR_BLOCKING_TASK = 'lk.blocking.task';
/** Not populated by the Node runtime: it cannot sample another thread's JavaScript stack. */
export const ATTR_BLOCKING_STACK = 'lk.blocking.stack';
/** Garbage-collection pause time inside the stall, in seconds. */
export const ATTR_BLOCKING_GC_TIME = 'lk.blocking.gc_time';
/**
 * CPU consumed by the event-loop thread during the stall, in seconds. On Node runtimes without
 * `process.threadCpuUsage()` (before 22.15 / 23.9) it is process-wide instead, counting the libuv
 * pool and native media threads too, and can then exceed `lk.blocking.duration`.
 */
export const ATTR_BLOCKING_CPU_TIME = 'lk.blocking.cpu_time';
/** Not populated by the Node runtime: there is no lazy-import equivalent to attribute. */
export const ATTR_BLOCKING_IMPORT = 'lk.blocking.import';
export const ATTR_BLOCKING_SUPPRESSED = 'lk.blocking.suppressed';
// Summary attributes on agent_session.
export const ATTR_BLOCKING_COUNT = 'lk.blocking.count';
export const ATTR_BLOCKING_TOTAL_DURATION = 'lk.blocking.total_duration';
export const ATTR_BLOCKING_MAX_DURATION = 'lk.blocking.max_duration';

// OpenTelemetry GenAI semantic conventions, mirroring the attribute registry of
// https://github.com/open-telemetry/semantic-conventions-genai. Backends ingest these
// directly, so the names must stay byte-for-byte identical to the registry. The ones the
// spec flags as sensitive are listed in GEN_AI_PII_ATTRIBUTES in ./pii.ts, since a
// standard name cannot carry the `lk.pii.` marker segment.

export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const ATTR_GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';

export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const ATTR_GEN_AI_REQUEST_STREAM = 'gen_ai.request.stream';

export const ATTR_GEN_AI_RESPONSE_ID = 'gen_ai.response.id';
export const ATTR_GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
export const ATTR_GEN_AI_RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons';
/** Time to first chunk of a streaming response, in seconds. */
export const ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK = 'gen_ai.response.time_to_first_chunk';

export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens';
export const ATTR_GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS = 'gen_ai.usage.cache_write.input_tokens';
export const ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS = 'gen_ai.usage.reasoning.output_tokens';
export const ATTR_GEN_AI_USAGE_TEXT_INPUT_TOKENS = 'gen_ai.usage.text.input_tokens';
export const ATTR_GEN_AI_USAGE_TEXT_OUTPUT_TOKENS = 'gen_ai.usage.text.output_tokens';
export const ATTR_GEN_AI_USAGE_AUDIO_INPUT_TOKENS = 'gen_ai.usage.audio.input_tokens';
export const ATTR_GEN_AI_USAGE_AUDIO_OUTPUT_TOKENS = 'gen_ai.usage.audio.output_tokens';

export const ATTR_GEN_AI_CONVERSATION_ID = 'gen_ai.conversation.id';

export const ATTR_GEN_AI_AGENT_NAME = 'gen_ai.agent.name';

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

export const ATTR_GEN_AI_RETRIEVAL_DOCUMENTS = 'gen_ai.retrieval.documents';
export const ATTR_GEN_AI_RETRIEVAL_QUERY_TEXT = 'gen_ai.retrieval.query.text';
export const ATTR_GEN_AI_MEMORY_QUERY_TEXT = 'gen_ai.memory.query.text';
export const ATTR_GEN_AI_MEMORY_RECORDS = 'gen_ai.memory.records';
export const ATTR_GEN_AI_EVALUATION_EXPLANATION = 'gen_ai.evaluation.explanation';
/** Template attribute: the concrete key is `gen_ai.prompt.variable.<name>`. */
export const ATTR_GEN_AI_PROMPT_VARIABLE = 'gen_ai.prompt.variable';
export const ATTR_GEN_AI_WORKFLOW_NAME = 'gen_ai.workflow.name';

export const ATTR_ERROR_TYPE = 'error.type';

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
];

const PROVIDER_BY_NAME: Record<string, string> = {
  amazon: 'aws.bedrock',
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
  // only the Bedrock endpoints, not every AWS service that shares the domain
  if (host.startsWith('bedrock') && host.endsWith('.amazonaws.com')) return 'aws.bedrock';

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

// Exception attributes
export const ATTR_EXCEPTION_TRACE = 'exception.stacktrace';
export const ATTR_EXCEPTION_TYPE = 'exception.type';
export const ATTR_EXCEPTION_MESSAGE = 'exception.message';

// Platform-specific attributes
export const ATTR_LANGFUSE_COMPLETION_START_TIME = 'langfuse.observation.completion_start_time';
