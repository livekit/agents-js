// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Public expressive presets.
 *
 * A preset is a *use-case* (customer service, casual) that is
 * provider-agnostic at the call site:
 *
 * ```ts
 * import { voice } from '@livekit/agents';
 *
 * const session = new AgentSession({
 *   tts: 'inworld/inworld-tts-2',
 *   expressive: voice.presets.CASUAL,
 * });
 * ```
 *
 * Each `presets.*` constant is just an {@link ExpressiveOptions} carrying a `preset`.
 * At session start the framework resolves it against the active TTS provider (via
 * `tts._markupProviderKey()`) and injects the variant tuned for that provider's markup
 * tags. A provider with no tuned preset falls back to the agnostic default, which still
 * injects that provider's tag reference through the `{tts.markup.llm_instructions}`
 * placeholder — so a preset always does something sensible and can never disagree with
 * the markup pipeline (both read the same provider key).
 *
 * Customize by spreading a constant into a new object (don't mutate the constant in place):
 *
 * ```ts
 * expressive: { ...presets.CUSTOMER_SERVICE, ttsInstructionsAppend: 'Confirm the name.' }
 * ```
 */
import { Instructions, isInstructions } from '../llm/chat_context.js';
import {
  CARTESIA_CASUAL,
  CARTESIA_CUSTOMER_SERVICE,
  INWORLD_CASUAL,
  INWORLD_CUSTOMER_SERVICE,
  XAI_CASUAL,
  XAI_CUSTOMER_SERVICE,
} from '../tts/_provider_format.js';
import type { ExpressiveOptions } from './agent_session.js';

/** The domain a preset is tuned for. Used to key the per-provider registry. */
export enum Preset {
  CUSTOMER_SERVICE = 'customer_service',
  CASUAL = 'casual',
}

// (provider key as returned by `tts._markupProviderKey()`) -> preset -> body
const REGISTRY: Record<string, Partial<Record<Preset, ExpressiveOptions>>> = {
  inworld: {
    [Preset.CUSTOMER_SERVICE]: INWORLD_CUSTOMER_SERVICE,
    [Preset.CASUAL]: INWORLD_CASUAL,
  },
  cartesia: {
    [Preset.CUSTOMER_SERVICE]: CARTESIA_CUSTOMER_SERVICE,
    [Preset.CASUAL]: CARTESIA_CASUAL,
  },
  xai: {
    [Preset.CUSTOMER_SERVICE]: XAI_CUSTOMER_SERVICE,
    [Preset.CASUAL]: XAI_CASUAL,
  },
};

function append(template: Instructions | string, extra: string): Instructions {
  // concatenate the *raw* template text so any {placeholders} survive until render()
  if (isInstructions(template)) {
    return new Instructions(template.common + '\n\n' + extra, {
      audio: template.audio,
      text: template.text,
    });
  }
  return new Instructions(template + '\n\n' + extra);
}

/**
 * Resolve a user {@link ExpressiveOptions} to a concrete options object for a provider.
 *
 * If `expr` carries a `preset`, start from that provider's tuned preset (or
 * `defaultOptions` when the provider has none); otherwise start from `defaultOptions`.
 * Then apply any explicit `ttsInstructionsTemplate` override and `ttsInstructionsAppend`.
 * The returned object always has `ttsInstructionsTemplate` and never the `preset` /
 * `ttsInstructionsAppend` helper keys.
 */
export function resolveOptions(
  expr: ExpressiveOptions,
  options: { providerKey: string; defaultOptions: ExpressiveOptions },
): ExpressiveOptions {
  const { providerKey, defaultOptions } = options;

  const preset = expr.preset;
  const base =
    preset !== undefined ? REGISTRY[providerKey]?.[preset] ?? defaultOptions : defaultOptions;

  let ttsTmpl = expr.ttsInstructionsTemplate ?? base.ttsInstructionsTemplate!;
  const extra = expr.ttsInstructionsAppend;
  if (extra) {
    ttsTmpl = append(ttsTmpl, extra);
  }

  return {
    ttsInstructionsTemplate: ttsTmpl,
  };
}

export const CUSTOMER_SERVICE: ExpressiveOptions = { preset: Preset.CUSTOMER_SERVICE };
export const CASUAL: ExpressiveOptions = { preset: Preset.CASUAL };
