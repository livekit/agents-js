// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-language `unlikely` thresholds for the mini detector.
 *
 * The cloud `turn-detector-v1` model receives calibrated defaults from the
 * inference gateway (via the `SessionCreated` message); only the local
 * `turn-detector-v1-mini` model ships a hardcoded table here.
 */
import { APIError } from '../../_exceptions.js';
import type { LanguageCode } from '../../language.js';

/** Full model name (used for telemetry/billing via `detector.model`). */
export type TurnDetectorModel = 'turn-detector-v1' | 'turn-detector-v1-mini';

/** Public `version` constructor argument; maps to a {@link TurnDetectorModel}. */
export type TurnDetectorVersion = 'v1' | 'v1-mini';

export const LOCAL_LANGUAGES: Readonly<Record<string, number>> = {
  ar: 0.35,
  de: 0.245,
  en: 0.36,
  es: 0.35,
  fr: 0.285,
  hi: 0.305,
  id: 0.345,
  it: 0.23,
  ja: 0.295,
  ko: 0.4,
  nl: 0.2,
  pt: 0.32,
  tr: 0.255,
  zh: 0.355,
};

/**
 * BCP-47 language tag (or human-readable name) → ISO 639-1 two-letter code.
 *
 * Covers the languages present in the threshold tables. Unknown inputs are
 * returned lowercased and unchanged (callers should pass `en`, `en-US`,
 * `English`, etc.).
 */
function normalizeLanguage(input: string): string {
  const lower = input.toLowerCase().trim();
  if (lower.length === 2) return lower;
  const dashIdx = lower.indexOf('-');
  if (dashIdx === 2) return lower.slice(0, 2);
  // long-name aliases for languages in our tables
  const aliases: Record<string, string> = {
    arabic: 'ar',
    german: 'de',
    english: 'en',
    spanish: 'es',
    french: 'fr',
    hindi: 'hi',
    indonesian: 'id',
    italian: 'it',
    japanese: 'ja',
    korean: 'ko',
    dutch: 'nl',
    portuguese: 'pt',
    turkish: 'tr',
    chinese: 'zh',
    mandarin: 'zh',
  };
  return aliases[lower] ?? lower;
}

const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;

/**
 * User-supplied threshold override: a single value applied to every language,
 * a per-language map, or `undefined` (use the defaults).
 */
export type ThresholdOverride = number | Record<string, number> | undefined;

function normalizeOverrides(overrides: ThresholdOverride): ThresholdOverride {
  if (overrides === undefined || typeof overrides !== 'object') {
    return overrides;
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(overrides)) {
    out[normalizeLanguage(k)] = Number(v);
  }
  return out;
}

/**
 * Resolves per-language `unlikely` thresholds for the audio EOT detector.
 *
 * Holds three layers and re-materializes the effective map whenever any of
 * them changes:
 *
 * - **overrides** — what the user passed (`unlikelyThreshold`), normalized.
 * - **server/shipped defaults** — for `turn-detector-v1-mini` these are the
 *   shipped `LOCAL_LANGUAGES` table; for the cloud `turn-detector-v1` they arrive
 *   from the gateway via `_updateDefaults` (the `SessionCreated` message) and
 *   are `undefined` until then.
 * - **materialized** — `thresholds` (per-language map) + `defaultThreshold`
 *   (catch-all for languages absent from the map).
 *
 * The detector and its (single) active stream share one instance; the
 * cloud→local fallback mutates it in place via `_toLocalFallback`.
 */
export class ThresholdOptions {
  private _model: TurnDetectorModel;
  private _overrides: ThresholdOverride;
  private _bcOverrides: ThresholdOverride;

  // server/shipped defaults
  private _serverThresholds: Record<string, number> | undefined;
  private _serverDefault: number | undefined;

  // backchannel server defaults: cloud-only (the local mini model produces no
  // backchannel probability), arrive via `SessionCreated`.
  private _serverBcThresholds: Record<string, number> | undefined;
  private _serverBcDefault: number | undefined;

  // materialized values (server defaults layered with user overrides)
  private _thresholds: Record<string, number> = {};
  private _default: number | undefined = undefined;
  private _bcThresholds: Record<string, number> = {};
  private _bcDefault: number | undefined = undefined;

  constructor(
    model: TurnDetectorModel,
    overrides: ThresholdOverride = undefined,
    backchannelOverrides: ThresholdOverride = undefined,
  ) {
    this._model = model;
    this._overrides = normalizeOverrides(overrides);
    this._bcOverrides = normalizeOverrides(backchannelOverrides);
    if (model === 'turn-detector-v1-mini') {
      this._serverThresholds = { ...LOCAL_LANGUAGES };
      this._serverDefault = LOCAL_LANGUAGES.en;
    }
    this._resolve();
  }

  get model(): TurnDetectorModel {
    return this._model;
  }

  get overrides(): ThresholdOverride {
    return this._overrides;
  }

  get backchannelOverrides(): ThresholdOverride {
    return this._bcOverrides;
  }

  get thresholds(): Readonly<Record<string, number>> {
    return this._thresholds;
  }

  get defaultThreshold(): number | undefined {
    return this._default;
  }

  lookup(language: LanguageCode | string | undefined): number | undefined {
    const key = language ? normalizeLanguage(language) : 'en';
    // `key in map`, not `?? default` — a legitimate override of 0 must not
    // fall through to the catch-all default.
    return key in this._thresholds ? this._thresholds[key] : this._default;
  }

  /**
   * Backchannel threshold for a language, or `undefined` when backchannel is
   * disabled — no server defaults / overrides resolved, or the resolved value is
   * non-positive (an explicit "off"). Backchannel is server-driven and cloud-only.
   */
  lookupBackchannel(language: LanguageCode | string | undefined): number | undefined {
    if (Object.keys(this._bcThresholds).length === 0 && this._bcDefault === undefined) {
      return undefined;
    }
    const key = language ? normalizeLanguage(language) : 'en';
    const threshold = key in this._bcThresholds ? this._bcThresholds[key] : this._bcDefault;
    return threshold !== undefined && threshold > 0 ? threshold : undefined;
  }

  supports(language: LanguageCode | string | undefined): boolean {
    // A cloud detector reports every language as supported until its server
    // defaults arrive, so the first turn (before `SessionCreated`) isn't
    // skipped by the `audio_recognition` short-circuit.
    const pending = this._model === 'turn-detector-v1' && this._serverThresholds === undefined;
    return pending || this.lookup(language) !== undefined;
  }

  updateOverrides(overrides: ThresholdOverride): void {
    this._overrides = normalizeOverrides(overrides);
    this._resolve();
  }

  updateBackchannelOverrides(overrides: ThresholdOverride): void {
    this._bcOverrides = normalizeOverrides(overrides);
    this._resolve();
  }

  /**
   * @internal Adopt the calibrated defaults a `turn-detector` gateway sends in
   * `SessionCreated`. Raises (non-retryable) when the server produced no usable
   * thresholds — the caller degrades the session to the local model.
   */
  _updateDefaults(
    serverThresholds: Record<string, number>,
    serverDefault: number,
    backchannelThresholds?: Record<string, number>,
    backchannelDefault = 0,
  ): void {
    if (!serverThresholds || Object.keys(serverThresholds).length === 0 || serverDefault <= 0) {
      throw new APIError('turn detector session created without usable default thresholds', {
        retryable: false,
      });
    }
    const norm: Record<string, number> = {};
    for (const [lang, value] of Object.entries(serverThresholds)) {
      norm[normalizeLanguage(lang)] = round4(value);
    }
    this._serverThresholds = norm;
    this._serverDefault = round4(serverDefault);

    // backchannel defaults are optional; an absent/empty map keeps backchannel disabled
    if (backchannelThresholds && Object.keys(backchannelThresholds).length > 0) {
      const bcNorm: Record<string, number> = {};
      for (const [lang, value] of Object.entries(backchannelThresholds)) {
        bcNorm[normalizeLanguage(lang)] = round4(value);
      }
      this._serverBcThresholds = bcNorm;
    } else {
      this._serverBcThresholds = undefined;
    }
    this._serverBcDefault = backchannelDefault > 0 ? round4(backchannelDefault) : undefined;

    this._resolve();
  }

  /**
   * @internal Promote to the local mini model on cloud→local fallback,
   * preserving the user's effective-vs-default ratio per language:
   * `local = LOCAL[lang] * (effective_t / server[lang])`.
   */
  _toLocalFallback(): void {
    if (this._model === 'turn-detector-v1-mini') {
      return;
    }

    let rescaled: Record<string, number> | undefined;
    const server = this._serverThresholds;
    if (server) {
      rescaled = {};
      for (const lang of Object.keys(server)) {
        const activeT = this.lookup(lang);
        const local = LOCAL_LANGUAGES[lang];
        if (activeT !== undefined && local !== undefined && server[lang] !== 0) {
          rescaled[lang] = local * (activeT / server[lang]!);
        }
      }
    }

    this._model = 'turn-detector-v1-mini';
    this._serverThresholds = { ...LOCAL_LANGUAGES };
    this._serverDefault = LOCAL_LANGUAGES.en;
    // the mini model produces no backchannel probability
    this._serverBcThresholds = undefined;
    this._serverBcDefault = undefined;
    this._resolve();

    if (rescaled !== undefined) {
      this._thresholds = rescaled;
      this._default = this.lookup('en');
    }
  }

  private _resolve(): void {
    [this._thresholds, this._default] = ThresholdOptions._resolveLayer(
      this._serverThresholds,
      this._serverDefault,
      this._overrides,
    );
    [this._bcThresholds, this._bcDefault] = ThresholdOptions._resolveLayer(
      this._serverBcThresholds,
      this._serverBcDefault,
      this._bcOverrides,
    );
  }

  /**
   * Layer a user override onto the server defaults. A scalar override replaces
   * the whole map (every language resolves through it); a dict override is
   * merged over the server map. Before server defaults arrive, only a scalar
   * override resolves up front.
   */
  private static _resolveLayer(
    serverThresholds: Record<string, number> | undefined,
    serverDefault: number | undefined,
    overrides: ThresholdOverride,
  ): [Record<string, number>, number | undefined] {
    const scalarOverride = typeof overrides === 'number';
    if (serverThresholds === undefined || serverDefault === undefined) {
      // cloud defaults not received yet; only a scalar override resolves up front
      return [{}, scalarOverride ? (overrides as number) : undefined];
    }

    if (overrides === undefined) {
      return [{ ...serverThresholds }, serverDefault];
    }

    if (scalarOverride) {
      return [{}, overrides as number];
    }

    return [{ ...serverThresholds, ...(overrides as Record<string, number>) }, serverDefault];
  }
}
