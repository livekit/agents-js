// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Instructions } from '../llm/chat_context.js';
import type { ExpressiveOptions } from './agent_session.js';

export enum Preset {
  CustomerService = 'customer_service',
  Casual = 'casual',
}

const CUSTOMER_SERVICE_SUFFIX =
  'Speak like a warm, caring support agent: patient, attentive, professional, and never robotic. Lead with empathy, then resolve. Vary delivery to fit the customer while keeping the interaction calm and on-task.';

const CASUAL_SUFFIX =
  'Speak like a real person mid-conversation with a friend: present, reactive, natural, and never flat or scripted. Mirror the user energy, use contractions, and vary delivery so no two turns sound the same.';

const PRESET_SUFFIXES: Record<Preset, string> = {
  [Preset.CustomerService]: CUSTOMER_SERVICE_SUFFIX,
  [Preset.Casual]: CASUAL_SUFFIX,
};

function append(template: string | Instructions, extra: string): string | Instructions {
  if (template instanceof Instructions) {
    return template.concat(`\n\n${extra}`);
  }
  return `${template}\n\n${extra}`;
}

export function resolveOptions(
  expressive: ExpressiveOptions,
  defaultOptions: ExpressiveOptions,
): ExpressiveOptions {
  let template = expressive.ttsInstructionsTemplate ?? defaultOptions.ttsInstructionsTemplate ?? '';
  const preset = expressive.preset;
  if (preset !== undefined) {
    template = append(template, PRESET_SUFFIXES[preset]);
  }
  if (expressive.ttsInstructionsAppend) {
    template = append(template, expressive.ttsInstructionsAppend);
  }

  return { ttsInstructionsTemplate: template };
}

export const CUSTOMER_SERVICE: ExpressiveOptions = { preset: Preset.CustomerService };
export const CASUAL: ExpressiveOptions = { preset: Preset.Casual };
