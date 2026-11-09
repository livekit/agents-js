// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Suggests what the caller could say next for the homepage demo's "try saying" line.
 * This sidecar does not affect the voice agent itself.
 */
import { llm, log, voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';

const logger = log().child({ example: 'homepage-frontdesk-suggestions' });

export const SUGGESTIONS_ATTRIBUTE = 'lk.agent.suggestions';
export const SUGGESTIONS_MODEL = 'google/gemma-4-31b-it';
const MAX_SUGGESTIONS = 3;
const RECENT_TURNS = 8;
const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'suggested_replies',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['suggestions'],
      properties: {
        suggestions: {
          type: 'array',
          maxItems: MAX_SUGGESTIONS,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'value'],
            properties: { label: { type: 'string' }, value: { type: 'string' } },
          },
        },
      },
    },
  },
};

const INSTRUCTIONS = `You help the CALLER on a phone call with {persona}. Given the call so far, suggest 1-3 short things the caller could say next, so someone unsure what to say has a line ready. Each has a label of three words or fewer, for a button, and the exact words the caller says.

How to choose:
- The words are a natural first-person line, one or two short sentences, answering exactly what {persona} just asked and nothing more.
- The caller reads the line out loud, so write it the way people speak: no symbols or abbreviations, "forty-two dollars and eighteen cents" rather than "$42.18".
- The caller's details come only from the script below. Never invent any other name, date, number, or amount.
- If {persona} is reading something back to confirm it, the reply is a short yes, or the correction from the script.
- If {persona} offered choices, pick from them, in {persona}'s words.
- Put the most useful reply first.
- While {persona} is still doing something they said they'd do ("one sec", "pulling that up", "let me check"), the caller just waits: suggest nothing. Otherwise always suggest at least one.

{script}

Return only JSON in this exact shape: {"suggestions":[{"label":"three words or fewer","value":"what the caller says"}]}`;

interface Suggestion {
  label: string;
  value: string;
}

export class SuggestedReplies {
  private stream?: llm.LLMStream;
  private generation = 0;

  constructor(
    private readonly session: voice.AgentSession,
    private readonly room: Room,
    private readonly model: llm.LLM,
    private readonly persona: string,
    private readonly script: () => string | undefined,
  ) {}

  attach(): SuggestedReplies {
    this.session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
      if (!(item instanceof llm.ChatMessage) || item.role !== 'assistant') return;
      // Leave a line up while the caller talks over Riley; Riley's next turn replaces it.
      if (item.interrupted || this.session.userState === 'speaking') return;
      this.generation += 1;
      this.stream?.close();
      void this.run(item.textContent ?? '', this.generation);
    });
    return this;
  }

  private async run(line: string, generation: number): Promise<void> {
    try {
      await this.suggest(line, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      logger.error({ error }, 'suggested replies failed');
    }
  }

  private async suggest(line: string, generation: number): Promise<void> {
    await this.publish([]);
    const script = this.script();
    if (script === undefined) return;

    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({
      role: 'system',
      content: INSTRUCTIONS.replaceAll('{persona}', this.persona).replace('{script}', script),
    });
    chatCtx.addMessage({ role: 'user', content: this.prompt(line) });
    const stream = this.model.chat({ chatCtx, extraKwargs: { response_format: RESPONSE_FORMAT } });
    this.stream = stream;
    let raw = '';
    try {
      for await (const chunk of stream) {
        if (chunk.delta?.content) raw += chunk.delta.content;
      }
    } finally {
      stream.close();
      if (this.stream === stream) this.stream = undefined;
    }
    if (generation !== this.generation || this.session.userState === 'speaking') return;
    await this.publish(parseSuggestions(raw));
  }

  private prompt(line: string): string {
    const turns = this.session.history.items
      .filter(
        (item): item is llm.ChatMessage =>
          item instanceof llm.ChatMessage &&
          (item.role === 'user' || item.role === 'assistant') &&
          Boolean(item.textContent),
      )
      .map((item) => `${item.role === 'user' ? 'Caller' : this.persona}: ${item.textContent}`);
    const recent = turns.slice(-RECENT_TURNS).join('\n');
    return `The call so far:\n${recent}\n\n${this.persona} just said: "${line}"\nWhat does the caller say next?`;
  }

  private async publish(items: Suggestion[]): Promise<void> {
    await this.room.localParticipant!.setAttributes({
      [SUGGESTIONS_ATTRIBUTE]: JSON.stringify(items),
    });
  }
}

function parseSuggestions(raw: string): Suggestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return [];
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.suggestions)) return [];
  return parsed.suggestions
    .filter(isRecord)
    .flatMap((item) => {
      if (typeof item.label !== 'string' || typeof item.value !== 'string') return [];
      const label = item.label.trim();
      const value = item.value.trim();
      return label && value ? [{ label, value }] : [];
    })
    .slice(0, MAX_SUGGESTIONS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
