// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Supported Rime AI TTS models */
export type TTSModels = 'coda' | 'mistv2' | 'mistv3';

/** A Coda pronunciation override, matched as a whole word or phrase, ignoring case. */
export interface CustomLexiconEntry {
  /** The word or phrase as Coda reads it, for example `Doctor` rather than `Dr.`. */
  spelling: string;
  /** X-SAMPA phonemes separated by spaces, for example `h E . " l oU`. */
  pronunciation: string;
}

/** Supported default languages for Rime AI TTS */
export type DefaultLanguages = 'eng' | 'spa' | 'fra' | 'ger';
