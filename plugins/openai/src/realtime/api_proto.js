// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export const SAMPLE_RATE = 24000;
export const NUM_CHANNELS = 1;
export const INPUT_PCM_FRAME_SIZE = 2400; // 100ms
export const OUTPUT_PCM_FRAME_SIZE = 1200; // 50ms
export const API_URL = 'wss://api.openai.com/v1/realtime';
export var Voice;
(function (Voice) {
  Voice['ALLOY'] = 'alloy';
  Voice['SHIMMER'] = 'shimmer';
  Voice['ECHO'] = 'echo';
})(Voice || (Voice = {}));
export var AudioFormat;
(function (AudioFormat) {
  AudioFormat['PCM16'] = 'pcm16';
  // G711_ULAW = 'g711-ulaw',
  // G711_ALAW = 'g711-alaw',
})(AudioFormat || (AudioFormat = {}));
export var Role;
(function (Role) {
  Role['SYSTEM'] = 'system';
  Role['ASSISTANT'] = 'assistant';
  Role['USER'] = 'user';
  Role['TOOL'] = 'tool';
})(Role || (Role = {}));
export var GenerationFinishedReason;
(function (GenerationFinishedReason) {
  GenerationFinishedReason['STOP'] = 'stop';
  GenerationFinishedReason['MAX_TOKENS'] = 'max_tokens';
  GenerationFinishedReason['CONTENT_FILTER'] = 'content_filter';
  GenerationFinishedReason['INTERRUPT'] = 'interrupt';
})(GenerationFinishedReason || (GenerationFinishedReason = {}));
export var InputTranscriptionModel;
(function (InputTranscriptionModel) {
  InputTranscriptionModel['WHISPER_1'] = 'whisper-1';
})(InputTranscriptionModel || (InputTranscriptionModel = {}));
export var Modality;
(function (Modality) {
  Modality['TEXT'] = 'text';
  Modality['AUDIO'] = 'audio';
})(Modality || (Modality = {}));
export var ToolChoice;
(function (ToolChoice) {
  ToolChoice['AUTO'] = 'auto';
  ToolChoice['NONE'] = 'none';
  ToolChoice['REQUIRED'] = 'required';
})(ToolChoice || (ToolChoice = {}));
export var State;
(function (State) {
  State['INITIALIZING'] = 'initializing';
  State['LISTENING'] = 'listening';
  State['THINKING'] = 'thinking';
  State['SPEAKING'] = 'speaking';
})(State || (State = {}));
// Response Resource
export var ResponseStatus;
(function (ResponseStatus) {
  ResponseStatus['IN_PROGRESS'] = 'in_progress';
  ResponseStatus['COMPLETED'] = 'completed';
  ResponseStatus['INCOMPLETE'] = 'incomplete';
  ResponseStatus['CANCELLED'] = 'cancelled';
  ResponseStatus['FAILED'] = 'failed';
})(ResponseStatus || (ResponseStatus = {}));
export var ClientEventType;
(function (ClientEventType) {
  ClientEventType['SessionUpdate'] = 'session.update';
  ClientEventType['InputAudioBufferAppend'] = 'input_audio_buffer.append';
  ClientEventType['InputAudioBufferCommit'] = 'input_audio_buffer.commit';
  ClientEventType['InputAudioBufferClear'] = 'input_audio_buffer.clear';
  ClientEventType['ConversationItemCreate'] = 'conversation.item.create';
  ClientEventType['ConversationItemTruncate'] = 'conversation.item.truncate';
  ClientEventType['ConversationItemDelete'] = 'conversation.item.delete';
  ClientEventType['ResponseCreate'] = 'response.create';
  ClientEventType['ResponseCancel'] = 'response.cancel';
})(ClientEventType || (ClientEventType = {}));
export var ServerEventType;
(function (ServerEventType) {
  ServerEventType['Error'] = 'error';
  ServerEventType['SessionCreated'] = 'session.created';
  ServerEventType['SessionUpdated'] = 'session.updated';
  ServerEventType['ConversationCreated'] = 'conversation.created';
  ServerEventType['InputAudioBufferCommitted'] = 'input_audio_buffer.committed';
  ServerEventType['InputAudioBufferCleared'] = 'input_audio_buffer.cleared';
  ServerEventType['InputAudioBufferSpeechStarted'] = 'input_audio_buffer.speech_started';
  ServerEventType['InputAudioBufferSpeechStopped'] = 'input_audio_buffer.speech_stopped';
  ServerEventType['ConversationItemCreated'] = 'conversation.item.created';
  ServerEventType['ConversationItemInputAudioTranscriptionCompleted'] =
    'conversation.item.input_audio_transcription.completed';
  ServerEventType['ConversationItemInputAudioTranscriptionFailed'] =
    'conversation.item.input_audio_transcription.failed';
  ServerEventType['ConversationItemTruncated'] = 'conversation.item.truncated';
  ServerEventType['ConversationItemDeleted'] = 'conversation.item.deleted';
  ServerEventType['ResponseCreated'] = 'response.created';
  ServerEventType['ResponseDone'] = 'response.done';
  ServerEventType['ResponseOutputItemAdded'] = 'response.output_item.added';
  ServerEventType['ResponseOutputItemDone'] = 'response.output_item.done';
  ServerEventType['ResponseContentPartAdded'] = 'response.content_part.added';
  ServerEventType['ResponseContentPartDone'] = 'response.content_part.done';
  ServerEventType['ResponseTextDelta'] = 'response.text.delta';
  ServerEventType['ResponseTextDone'] = 'response.text.done';
  ServerEventType['ResponseAudioTranscriptDelta'] = 'response.audio_transcript.delta';
  ServerEventType['ResponseAudioTranscriptDone'] = 'response.audio_transcript.done';
  ServerEventType['ResponseAudioDelta'] = 'response.audio.delta';
  ServerEventType['ResponseAudioDone'] = 'response.audio.done';
  ServerEventType['ResponseFunctionCallArgumentsDelta'] = 'response.function_call_arguments.delta';
  ServerEventType['ResponseFunctionCallArgumentsDone'] = 'response.function_call_arguments.done';
  ServerEventType['RateLimitsUpdated'] = 'response.rate_limits.updated';
})(ServerEventType || (ServerEventType = {}));
//# sourceMappingURL=api_proto.js.map
