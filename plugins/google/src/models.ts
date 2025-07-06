export enum AudioEncoding {
  AUDIO_ENCODING_UNSPECIFIED = 'AUDIO_ENCODING_UNSPECIFIED',
  LINEAR16 = 'LINEAR16',
  MULAW = 'MULAW',
  ALAW = 'ALAW',
  AMR = 'AMR',
  AMR_WB = 'AMR_WB',
  FLAC = 'FLAC',
  MP3 = 'MP3',
  OGG_OPUS = 'OGG_OPUS',
  WEBM_OPUS = 'WEBM_OPUS',
  MP4_AAC = 'MP4_AAC',
  M4A_AAC = 'M4A_AAC',
  MOV_AAC = 'MOV_AAC',
}

export enum SpeechEventType {
  SPEECH_EVENT_TYPE_UNSPECIFIED = 'SPEECH_EVENT_TYPE_UNSPECIFIED',
  END_OF_SINGLE_UTTERANCE = 'END_OF_SINGLE_UTTERANCE',
  SPEECH_ACTIVITY_BEGIN = 'SPEECH_ACTIVITY_BEGIN',
  SPEECH_ACTIVITY_END = 'SPEECH_ACTIVITY_END',
}

// Google Cloud Speech-to-Text API types
export interface GoogleCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

export type SpeechLanguages =
  | 'en-US'
  | 'en-GB'
  | 'en-AU'
  | 'en-CA'
  | 'pl-PL'
  | 'de-DE'
  | 'fr-FR'
  | 'es-ES'
  | 'it-IT'
  | 'pt-BR'
  | 'ru-RU'
  | 'ja-JP'
  | 'ko-KR'
  | 'zh-CN'
  | 'zh-TW'
  | 'ar-SA'
  | 'hi-IN'
  | 'th-TH'
  | 'vi-VN'
  | 'tr-TR';

export type SpeechModels =
  | 'latest_long'
  | 'latest_short'
  | 'latest_medium'
  | 'command_and_search'
  | 'phone_call'
  | 'video'
  | 'default'
  | 'medical_conversation'
  | 'medical_dictation'
  | 'medical_question_and_answer'
  | 'medical_report'
  | 'medical_symptom'
  | 'medical_test'
  | 'medical_treatment'
  | 'medical_emergency'
  | 'medical_consultation'
  | 'medical_instruction'
  | 'medical_procedure'
  | 'medical_medication'
  | 'medical_diagnosis'
  | 'medical_condition';

export type LanguageType = SpeechLanguages | string;
export type LanguageCode = LanguageType | LanguageType[];
