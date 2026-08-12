// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { splitWords } from '../tokenize/basic/word.js';
import {
  DEFAULT_SPEECH_STEERING_OPTIONS,
  TranscriptMarkupStripper,
} from '../tts/provider_format.js';
import {
  DEFAULT_EXPRESSIVE_OPTIONS,
  type ExpressiveOptions,
  TTS_INSTRUCTIONS_PLACEHOLDER,
  resolveExpressiveOptions,
} from './agent_session.js';
import { AgentSession } from './agent_session.js';
import {
  EXPRESSIVE_INSTRUCTIONS_MESSAGE_ID,
  hasExpressiveInstructions,
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

describe('history-scrub gate', () => {
  // The scrub is destructive and uses the union of every provider's tag names, and its
  // branch is the default path for every session that never enabled expressive — so both
  // signals that license it must stay off until expressive was actually live.

  it('is off for a session that never enabled expressive', () => {
    expect(new AgentSession()._expressiveEverActive).toBe(false);
    expect(new AgentSession({ expressive: true })._expressiveEverActive).toBe(
      false,
      // still false: the latch flips when the guide is injected, not when the flag is set,
      // so a TTS with no markup dialect never licenses the scrub
    );
  });

  it('detects a restored history carrying the guide', () => {
    const ctx = ChatContext.empty();
    expect(hasExpressiveInstructions(ctx)).toBe(false);

    updateExpressiveInstructions(ctx, { text: 'markup guide' });
    expect(hasExpressiveInstructions(ctx)).toBe(true);

    removeExpressiveInstructions(ctx);
    expect(hasExpressiveInstructions(ctx)).toBe(false);
  });

  it('leaves angle-bracketed assistant text alone when nothing licenses a scrub', () => {
    // what the gate protects: an agent that legitimately writes provider-shaped tags in a
    // session that never used expressive
    const ctx = ChatContext.empty();
    ctx.addMessage({ role: 'assistant', content: 'Hold on <break time="1s"/> nearly there.' });

    expect(hasExpressiveInstructions(ctx)).toBe(false);
    // (the gate skips stripAssistantMarkup entirely; calling it would destroy this)
    stripAssistantMarkup(ctx);
    const scrubbed = ctx.items[0]!;
    expect(scrubbed.type === 'message' && scrubbed.textContent).toBe('Hold on nearly there.');
  });
});

describe('transcript pacing', () => {
  it('recognizes a markup tag shredded across word tokens', () => {
    // the word tokenizer emits whitespace-free runs, so the synchronizer must replay the
    // original slices of pushedText — feeding it the bare word tokens reassembles
    // `<exprtype="expression"label="warm surprise"/>`, which matches nothing and gets
    // paced as if it were spoken
    const pushedText = '<expr type="expression" label="warm surprise"/> Hello there';
    const stripper = new TranscriptMarkupStripper();

    let cursor = 0;
    let paced = '';
    for (const [word] of splitWords(pushedText, false)) {
      let end = pushedText.indexOf(word, cursor) + word.length;
      while (end < pushedText.length && !/\s/.test(pushedText[end]!)) end++;
      paced += stripper.push(pushedText.slice(cursor, end));
      cursor = end;
    }
    paced += stripper.flush();

    expect(paced).not.toContain('<expr');
    expect(paced.trim()).toBe('Hello there');
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

describe('custom template without the markup-guide placeholder', () => {
  // The placeholder is the only channel the provider's vocabulary has. A template that
  // omits it still injects a message and still turns on xml-aware chunking, markup
  // conversion and transcript stripping — the model just never learns the tags.

  const render = (expr: ExpressiveOptions) => {
    const resolved = resolveExpressiveOptions(expr, {
      providerKey: 'inworld',
      defaults: DEFAULT_EXPRESSIVE_OPTIONS,
    });
    return String(resolved.ttsInstructionsTemplate);
  };

  it('drops the vocabulary when the placeholder is missing', () => {
    const text = render({ ttsInstructionsTemplate: 'Be expressive, please.' });
    expect(text).not.toContain(TTS_INSTRUCTIONS_PLACEHOLDER);
    // ...yet it still renders to a non-empty guide message, so nothing downstream notices
    expect(text.trim()).not.toBe('');
  });

  it('still renders non-empty for an empty template, via the steering fragment', () => {
    // the appended delivery guidelines make `rendered.trim()` truthy even here
    const text = render({ ttsInstructionsTemplate: '' });
    expect(text).not.toContain(TTS_INSTRUCTIONS_PLACEHOLDER);
    expect(text.trim()).not.toBe('');
    expect(text).toContain('Delivery guidelines:');
  });

  it('keeps the placeholder when only appending', () => {
    // the documented way to add your own rules keeps the guide intact
    const text = render({ ttsInstructionsAppend: 'Stay upbeat.' });
    expect(text).toContain(TTS_INSTRUCTIONS_PLACEHOLDER);
    expect(text.endsWith('Stay upbeat.')).toBe(true);
  });

  it('warns at most once per session', () => {
    expect(new AgentSession()._warnedExpressiveTemplate).toBe(false);
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
