// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The Vartaloop model family. `narad` is the current Hinglish / Indian-English model.
 *
 * @remarks
 * The API has no model field; the value names the model in metrics and logs only.
 */
export type TTSModels = 'narad';

/**
 * A few of the voice ids. `GET /v1/voices` on the API lists every voice of the key with its
 * language, gender and the expressions it carries; any id from that list is accepted.
 */
export type TTSVoices =
  | 'saanvi'
  | 'sahil'
  | 'meera'
  | 'mahesh'
  | 'ananya'
  | 'arjun'
  | 'kiara'
  | 'kevin';

/**
 * Expression of the delivery (the API's `style` field). `neutral` sends nothing and plays the
 * voice as is. A voice without the requested expression plays neutral; an unknown name is a 400.
 * Newer models may add expressions; the value is passed through unchanged.
 */
export type TTSExpressions = 'neutral' | 'excited' | 'sad' | 'whisper';

/**
 * How digits are read in Hinglish text: `hi` Hindi number words, `mixed` codes / OTPs / phone
 * numbers in English digit names with amounts in Hindi, `en` English number words with Indian
 * grouping, `auto` picks `en` when the text has Latin words and `hi` otherwise. English voices
 * ignore it.
 */
export type TTSDigits = 'auto' | 'hi' | 'mixed' | 'en';

/**
 * Output chain profile. `telephony` adds a 300 Hz high-pass, a presence lift and a de-esser tuned
 * for 8 kHz mu-law / PSTN delivery.
 */
export type TTSProfiles = 'default' | 'telephony';
