// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { DEFAULT_SPEECH_STEERING_OPTIONS } from '../tts/provider_format.js';
import {
  DEFAULT_EXPRESSIVE_OPTIONS,
  type ExpressiveOptions,
  TTS_INSTRUCTIONS_PLACEHOLDER,
  resolveExpressiveOptions,
} from './agent_session.js';
import { AgentSession } from './agent_session.js';
import {
  EXPRESSIVE_INSTRUCTIONS_MESSAGE_ID,
  removeExpressiveInstructions,
  stripAssistantMarkup,
  updateExpressiveInstructions,
} from './generation.js';

// what an expressive turn actually leaves in history: the expr markers the LLM emitted,
// plus (defensively) a hallucinated native tag. Square brackets are *not* markup here —
// they reach history as prose or markdown links, so the scrub must leave them alone.
const MARKED_UP =
  '<expr type="expression" label="happy"/> Welcome back! <sound value="chuckle"/> ' +
  'Glad you called again. Docs: [the guide](https://docs.livekit.io).';

describe('stripAssistantMarkup', () => {
  it('scrubs assistant markup, keeps prose brackets and user content', () => {
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'assistant', content: MARKED_UP });
    ctx.addMessage({ role: 'user', content: 'I typed <expression value="happy"/> literally' });
    const plain = ctx.addMessage({ role: 'assistant', content: 'No tags here.' });
    const plainContent = plain.content;

    stripAssistantMarkup(ctx);

    const assistantTexts = ctx.items
      .filter((item) => item.type === 'message' && item.role === 'assistant')
      .map((item) => (item.type === 'message' ? item.textContent : undefined));

    expect(assistantTexts[0]).not.toContain('<expr');
    expect(assistantTexts[0]).not.toContain('<sound');
    expect(assistantTexts[0]).toContain('Welcome back!');
    expect(assistantTexts[0]).toContain('Glad you called again.');
    // markdown links survive: brackets are prose, not markup
    expect(assistantTexts[0]).toContain('[the guide](https://docs.livekit.io)');

    // user content is never touched, tag-shaped or not
    const userItem = ctx.items.find((item) => item.type === 'message' && item.role === 'user')!;
    expect(userItem.type === 'message' && userItem.textContent).toContain(
      '<expression value="happy"/>',
    );

    // tag-free assistant content is left as-is (fast path)
    expect(plain.content).toBe(plainContent);
  });
});

describe('expressive instruction message', () => {
  it('replaces rather than stacks, and can be removed', () => {
    const ctx = ChatContext.empty();
    updateExpressiveInstructions(ctx, { text: 'markup guide v1' });
    updateExpressiveInstructions(ctx, { text: 'markup guide v2' });

    const guides = ctx.items.filter((item) => item.id === EXPRESSIVE_INSTRUCTIONS_MESSAGE_ID);
    expect(guides, 're-injection must replace, not stack').toHaveLength(1);
    expect(guides[0]!.type === 'message' && guides[0]!.textContent).toBe('markup guide v2');

    removeExpressiveInstructions(ctx);
    expect(ctx.items.every((item) => item.id !== EXPRESSIVE_INSTRUCTIONS_MESSAGE_ID)).toBe(true);
  });
});

describe('AgentSession expressive option', () => {
  it('defaults to off and round-trips what was passed', () => {
    expect(new AgentSession()._expressive).toBe(false);
    expect(new AgentSession({ expressive: true })._expressive).toBe(true);

    const opts: ExpressiveOptions = { ttsInstructionsAppend: 'Stay upbeat.' };
    expect(new AgentSession({ expressive: opts })._expressive).toEqual(opts);
  });
});

describe('resolveExpressiveOptions', () => {
  const resolve = (expr: ExpressiveOptions, providerKey = 'inworld') =>
    resolveExpressiveOptions(expr, { providerKey, defaults: DEFAULT_EXPRESSIVE_OPTIONS });

  it('keeps the default template and steering when nothing is overridden', () => {
    const resolved = resolve({});
    const text = String(resolved.ttsInstructionsTemplate);
    // the raw placeholder survives resolution — it is filled at injection time
    expect(text.startsWith(String(DEFAULT_EXPRESSIVE_OPTIONS.ttsInstructionsTemplate))).toBe(true);
    expect(text).toContain(TTS_INSTRUCTIONS_PLACEHOLDER);
    // the default steering renders its one non-default field (fillers on)
    expect(text).toContain('Sprinkle in natural fillers');
    expect(resolved.speechSteering).toEqual(DEFAULT_SPEECH_STEERING_OPTIONS);
  });

  it('appends rendered steering guidelines to the template', () => {
    const resolved = resolve({ speechSteering: { nonverbalSounds: { laughing: false } } });
    const text = String(resolved.ttsInstructionsTemplate);
    expect(text).toContain('Delivery guidelines:');
    expect(text).toContain('Non-verbal sounds:');
    // an explicit steering value wins over the default, unset ones fall back
    expect(resolved.speechSteering).toEqual({
      disfluencies: true,
      nonverbalSounds: { laughing: false },
    });
  });

  it('lets an explicit template override the default, with append applied last', () => {
    const resolved = resolve({
      ttsInstructionsTemplate: `Custom. ${TTS_INSTRUCTIONS_PLACEHOLDER}`,
      ttsInstructionsAppend: 'Stay upbeat.',
      speechSteering: { disfluencies: false },
    });
    const text = String(resolved.ttsInstructionsTemplate);
    expect(text.startsWith('Custom. ')).toBe(true);
    expect(text).toContain('No fillers');
    // the user's free-form rules always win, so they come last
    expect(text.endsWith('Stay upbeat.')).toBe(true);
  });

  it('adds nothing for a provider with no steerable vocabulary', () => {
    const resolved = resolve({ speechSteering: {} }, 'cartesia');
    expect(String(resolved.ttsInstructionsTemplate)).toBe(
      String(DEFAULT_EXPRESSIVE_OPTIONS.ttsInstructionsTemplate) +
        '\n\nDelivery guidelines:\n- Sprinkle in natural fillers (um, uh) and openers ' +
        '(oh, well, so), zero to two per turn, never mechanical.',
    );
  });
});
