// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Ref: python livekit-plugins/livekit-plugins-minimax/livekit/plugins/minimax/tts.py - 27-38 lines
/** Supported MiniMax TTS models. */
export type TTSModel =
  | 'speech-2.8-hd'
  | 'speech-2.8-turbo'
  | 'speech-2.6-hd'
  | 'speech-2.6-turbo'
  | 'speech-2.5-hd-preview'
  | 'speech-2.5-turbo-preview'
  | 'speech-02-hd'
  | 'speech-02-turbo'
  | 'speech-01-hd'
  | 'speech-01-turbo';

// Ref: python livekit-plugins/livekit-plugins-minimax/livekit/plugins/minimax/tts.py - 40-83 lines
/**
 * A subset of commonly used MiniMax voice IDs. Any string is accepted by
 * {@link TTSOptions.voice} - these literals exist purely for IDE
 * auto-completion. See the MiniMax documentation for the full voice list.
 */
export type TTSVoice =
  // Social Media Voices
  | 'socialmedia_female_2_v1'
  | 'socialmedia_female_1_v1'
  // Voice Agent Series
  | 'voice_agent_Female_Phone_4'
  | 'voice_agent_Male_Phone_1'
  | 'voice_agent_Male_Phone_2'
  // English Voices - Female
  | 'English_StressedLady'
  | 'English_SentimentalLady'
  | 'English_radiant_girl'
  // English Voices - Male
  | 'English_WiseScholar'
  | 'English_Persuasive_Man'
  | 'English_Explanatory_Man'
  | 'English_Insightful_Speaker'
  // Japanese Voices
  | 'japanese_male_social_media_1_v2'
  | 'japanese_female_social_media_1_v2'
  // French Voices
  | 'French_CasualMan'
  | 'French_Female Journalist'
  // Spanish Voices
  | 'Spanish_Narrator'
  | 'Spanish_WiseScholar'
  | 'Spanish_ThoughtfulMan'
  // Arabic Voices
  | 'Arabic_CalmWoman'
  | 'Arabic_FriendlyGuy'
  // Portuguese Voices
  | 'Portuguese_ThoughtfulLady'
  // German Voices
  | 'German_PlayfulMan'
  | 'German_SweetLady'
  // MOSS Audio Series
  | 'moss_audio_7c7e7ae2-7356-11f0-9540-7ef9b4b62566'
  | 'moss_audio_b118f320-78c0-11f0-bbeb-26e8167c4779'
  | 'moss_audio_84f32de9-2363-11f0-b7ab-d255fae1f27b'
  | 'moss_audio_82ebf67c-78c8-11f0-8e8e-36b92fbb4f95';

// Ref: python livekit-plugins/livekit-plugins-minimax/livekit/plugins/minimax/tts.py - 89-92 lines
/**
 * MiniMax-supported emotions.
 *
 * @remarks `fluent` is only supported by `speech-2.6-*` models.
 */
export type TTSEmotion =
  | 'happy'
  | 'sad'
  | 'angry'
  | 'fearful'
  | 'disgusted'
  | 'surprised'
  | 'neutral'
  | 'fluent';

// Ref: python livekit-plugins/livekit-plugins-minimax/livekit/plugins/minimax/tts.py - 94-136 lines
/** Language hint for multilingual performance. */
export type TTSLanguageBoost =
  | 'auto'
  | 'Chinese'
  | 'Chinese,Yue'
  | 'English'
  | 'Arabic'
  | 'Russian'
  | 'Spanish'
  | 'French'
  | 'Portuguese'
  | 'German'
  | 'Turkish'
  | 'Dutch'
  | 'Ukrainian'
  | 'Vietnamese'
  | 'Indonesian'
  | 'Japanese'
  | 'Italian'
  | 'Korean'
  | 'Thai'
  | 'Polish'
  | 'Romanian'
  | 'Greek'
  | 'Czech'
  | 'Finnish'
  | 'Hindi'
  | 'Bulgarian'
  | 'Danish'
  | 'Hebrew'
  | 'Malay'
  | 'Persian'
  | 'Slovak'
  | 'Swedish'
  | 'Croatian'
  | 'Filipino'
  | 'Hungarian'
  | 'Norwegian'
  | 'Slovenian'
  | 'Catalan'
  | 'Nynorsk'
  | 'Tamil'
  | 'Afrikaans';

// Ref: python livekit-plugins/livekit-plugins-minimax/livekit/plugins/minimax/tts.py - 139 line
/**
 * Valid PCM sample rates accepted by the MiniMax API.
 */
export type TTSSampleRate = 8000 | 16000 | 22050 | 24000 | 32000 | 44100;

// Ref: python livekit-plugins/livekit-plugins-minimax/livekit/plugins/minimax/tts.py - 85-86 lines
export const DEFAULT_MODEL: TTSModel = 'speech-02-turbo';
export const DEFAULT_VOICE_ID: TTSVoice = 'socialmedia_female_2_v1';
// Ref: python livekit-plugins/livekit-plugins-minimax/livekit/plugins/minimax/tts.py - 142-144 lines
export const DEFAULT_BASE_URL = 'https://api-uw.minimax.io';
