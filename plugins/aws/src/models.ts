// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { Engine, LanguageCode, TextType } from '@aws-sdk/client-polly';

/**
 * Amazon Polly speech synthesis engine.
 * @public
 */
export type TTSSpeechEngine = Engine;

/**
 * Language code accepted by Amazon Polly's SynthesizeSpeech request.
 * @public
 */
export type TTSLanguage = LanguageCode;

/**
 * Whether the Amazon Polly input text is plain text or SSML.
 * @public
 */
export type TTSTextType = TextType;
