// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Module-private helpers for the Soniox plugin. Imported by `stt.ts` and
// exercised by `stt.test.ts`. Not re-exported from `index.ts`, and the
// package `exports` map blocks consumers from importing this file directly.
import { stt } from '@livekit/agents';

const END_TOKEN = '<end>';
const FINALIZED_TOKEN = '<fin>';

export interface SonioxToken {
  text: string;
  is_final: boolean;
  translation_status?: string;
  language?: string;
  speaker?: string | number;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
}

export interface SonioxMessage {
  tokens?: SonioxToken[];
  total_audio_proc_ms?: number;
  finished?: boolean;
  error_code?: string | number;
  error_message?: string;
}

export type LangSegment = [stt.SpeechData['language'], string];

export const isEndToken = (token: SonioxToken): boolean =>
  token.text === END_TOKEN || token.text === FINALIZED_TOKEN;

export const mergeLangSegments = (a: LangSegment[], b: LangSegment[]): LangSegment[] => {
  const result: LangSegment[] = a.map(([lang, text]) => [lang, text]);
  for (const [lang, text] of b) {
    const last = result[result.length - 1];
    if (last && last[0] === lang) {
      last[1] += text;
    } else {
      result.push([lang, text]);
    }
  }
  return result;
};

type LangFields = Pick<
  stt.SpeechData,
  'sourceLanguages' | 'sourceTexts' | 'targetLanguages' | 'targetTexts'
>;

/**
 * Route language segments into `SpeechData`'s source/target field pairs.
 * In translation mode `primary` becomes the target side and `original` the
 * source side; otherwise `primary` is the source and there is no target.
 * Empty inputs are omitted from the result.
 */
export const langFields = (
  isTranslationMode: boolean,
  primary: LangSegment[],
  original: LangSegment[],
): LangFields => {
  const source = isTranslationMode ? original : primary;
  const target = isTranslationMode ? primary : [];
  const fields: LangFields = {};
  if (source.length) {
    fields.sourceLanguages = source.map(([lang]) => lang);
    fields.sourceTexts = source.map(([, text]) => text);
  }
  if (target.length) {
    fields.targetLanguages = target.map(([lang]) => lang);
    fields.targetTexts = target.map(([, text]) => text);
  }
  return fields;
};

export class TokenAccumulator {
  text = '';
  language: stt.SpeechData['language'] = '' as stt.SpeechData['language'];
  speakerId?: string;
  startTime = 0;
  endTime = 0;
  #confidenceSum = 0;
  #confidenceCount = 0;
  #hasStartTime = false;
  #langSegments: LangSegment[] = [];
  // Map iteration is insertion-ordered; the strict `>` in #getLanguage means
  // the first-inserted language wins on ties. Python uses min(last-updated)
  // as its tiebreaker; this insertion-order semantic is close enough for an
  // opinionated lossy summary and avoids tracking timestamps.
  #langStats = new Map<string, number>();

  get langSegments(): LangSegment[] {
    return this.#langSegments;
  }

  get confidence(): number {
    return this.#confidenceCount === 0 ? 0 : this.#confidenceSum / this.#confidenceCount;
  }

  update(token: SonioxToken): void {
    const text = token.text;
    const lang = (token.language ?? '') as stt.SpeechData['language'];
    this.text += text;
    if (lang && text) {
      this.#langStats.set(lang, (this.#langStats.get(lang) ?? 0) + text.length);
      this.language = this.#getLanguage();
    }
    if (token.speaker !== undefined && this.speakerId === undefined) {
      this.speakerId = String(token.speaker);
    }
    if (token.start_ms !== undefined && !this.#hasStartTime) {
      this.#hasStartTime = true;
      this.startTime = token.start_ms;
    }
    if (token.end_ms !== undefined) {
      this.endTime = token.end_ms;
    }
    if (token.confidence !== undefined) {
      this.#confidenceSum += token.confidence;
      this.#confidenceCount += 1;
    }
    if (text) {
      const last = this.#langSegments[this.#langSegments.length - 1];
      if (last && last[0] === lang) {
        last[1] += text;
      } else {
        this.#langSegments.push([lang, text]);
      }
    }
  }

  reset(): void {
    this.text = '';
    this.language = '' as stt.SpeechData['language'];
    this.speakerId = undefined;
    this.startTime = 0;
    this.endTime = 0;
    this.#confidenceSum = 0;
    this.#confidenceCount = 0;
    this.#hasStartTime = false;
    this.#langSegments = [];
    this.#langStats.clear();
  }

  toSpeechData(startTimeOffset = 0): stt.SpeechData {
    return {
      text: this.text,
      language: this.language,
      speakerId: this.speakerId,
      startTime: this.startTime / 1000 + startTimeOffset,
      endTime: this.endTime / 1000 + startTimeOffset,
      confidence: this.confidence,
    };
  }

  mergedSpeechData(other: TokenAccumulator, startTimeOffset = 0): stt.SpeechData {
    const starts = [this, other].filter((acc) => acc.#hasStartTime).map((acc) => acc.startTime);
    const start = starts.length ? Math.min(...starts) : 0;
    const totalCount = this.#confidenceCount + other.#confidenceCount;
    const totalSum = this.#confidenceSum + other.#confidenceSum;
    return {
      text: this.text + other.text,
      language: this.language || other.language,
      speakerId: this.speakerId ?? other.speakerId,
      startTime: start / 1000 + startTimeOffset,
      endTime: Math.max(this.endTime, other.endTime) / 1000 + startTimeOffset,
      confidence: totalCount > 0 ? totalSum / totalCount : 0,
    };
  }

  #getLanguage(): stt.SpeechData['language'] {
    let selected = '';
    let maxChars = -1;
    for (const [lang, numChars] of this.#langStats) {
      if (numChars > maxChars) {
        maxChars = numChars;
        selected = lang;
      }
    }
    return selected as stt.SpeechData['language'];
  }
}

/**
 * Per-session state mutated across calls to {@link processMessage}.
 * `final` and `finalOriginal` accumulate finalized tokens until an endpoint
 * is reached; `isSpeaking` gates the START_OF_SPEECH event; `reportedDurationMs`
 * tracks audio-duration usage already emitted.
 */
export interface ProcessMessageState {
  final: TokenAccumulator;
  finalOriginal: TokenAccumulator;
  isSpeaking: boolean;
  reportedDurationMs: number;
}

export const newProcessMessageState = (): ProcessMessageState => ({
  final: new TokenAccumulator(),
  finalOriginal: new TokenAccumulator(),
  isSpeaking: false,
  reportedDurationMs: 0,
});

export interface ProcessMessageOptions {
  isTranslationMode: boolean;
  startTimeOffset: number;
}

function* sendEndpointTranscript(
  state: ProcessMessageState,
  options: ProcessMessageOptions,
): Generator<stt.SpeechEvent> {
  if (state.final.text) {
    if (!state.isSpeaking) {
      state.isSpeaking = true;
      yield { type: stt.SpeechEventType.START_OF_SPEECH };
    }
    yield {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          ...state.final.toSpeechData(options.startTimeOffset),
          ...langFields(
            options.isTranslationMode,
            state.final.langSegments,
            state.finalOriginal.langSegments,
          ),
        },
      ],
    };
    yield { type: stt.SpeechEventType.END_OF_SPEECH };
    state.final.reset();
    state.finalOriginal.reset();
    state.isSpeaking = false;
  } else {
    state.finalOriginal.reset();
  }
}

function* reportProcessedAudioDuration(
  totalAudioProcMs: number,
  state: ProcessMessageState,
): Generator<stt.SpeechEvent> {
  const toReportMs = totalAudioProcMs - state.reportedDurationMs;
  if (toReportMs <= 0) return;
  yield {
    type: stt.SpeechEventType.RECOGNITION_USAGE,
    recognitionUsage: {
      audioDuration: toReportMs / 1000,
    },
  };
  state.reportedDurationMs = Math.trunc(totalAudioProcMs);
}

/**
 * Process a single parsed Soniox WebSocket message, mutating `state` and
 * yielding the resulting {@link stt.SpeechEvent}s in order. The function is
 * pure with respect to its inputs — all session state lives in `state`.
 */
export function* processMessage(
  state: ProcessMessageState,
  content: SonioxMessage,
  options: ProcessMessageOptions,
): Generator<stt.SpeechEvent> {
  const tokens = content.tokens ?? [];
  const nonFinal = new TokenAccumulator();
  const nonFinalOriginal = new TokenAccumulator();
  const totalAudioProcMs = content.total_audio_proc_ms ?? 0;

  for (const token of tokens) {
    const isTranslated = token.translation_status === 'translation';
    if (options.isTranslationMode && !isEndToken(token) && !isTranslated) {
      if (token.is_final) {
        state.finalOriginal.update(token);
      } else {
        nonFinalOriginal.update(token);
      }
      continue;
    }
    if (token.is_final) {
      if (isEndToken(token)) {
        yield* sendEndpointTranscript(state, options);
        yield* reportProcessedAudioDuration(totalAudioProcMs, state);
      } else {
        state.final.update(token);
      }
    } else {
      nonFinal.update(token);
    }
  }

  if (state.final.text || nonFinal.text) {
    if (!state.isSpeaking) {
      state.isSpeaking = true;
      yield { type: stt.SpeechEventType.START_OF_SPEECH };
    }

    const mergedPrimary = mergeLangSegments(state.final.langSegments, nonFinal.langSegments);
    const mergedOriginals = mergeLangSegments(
      state.finalOriginal.langSegments,
      nonFinalOriginal.langSegments,
    );
    const eventType =
      state.final.text && !nonFinal.text
        ? stt.SpeechEventType.PREFLIGHT_TRANSCRIPT
        : stt.SpeechEventType.INTERIM_TRANSCRIPT;

    yield {
      type: eventType,
      alternatives: [
        {
          ...state.final.mergedSpeechData(nonFinal, options.startTimeOffset),
          ...langFields(options.isTranslationMode, mergedPrimary, mergedOriginals),
        },
      ],
    };
  }

  if (content.finished || content.error_code || content.error_message) {
    yield* sendEndpointTranscript(state, options);
    yield* reportProcessedAudioDuration(totalAudioProcMs, state);
  }
}
