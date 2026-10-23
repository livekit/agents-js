// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * A sidecar that suggests what the caller could say next.
 *
 * Built specifically for the frontend of the demo at
 * https://livekit.com/agents/hotel-receptionist.
 *
 * After each receptionist turn, a small LLM proposes one to three short replies the caller might
 * give. The suggestions are published on the agent participant as the `lk.agent.suggestions`
 * attribute so the web frontend can render clickable nudge chips.
 */
import { llm, log, voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';

const logger = log().child({ example: 'hotel-receptionist-suggestions' });

const SUGGESTIONS_ATTRIBUTE = 'lk.agent.suggestions';
const MAX_SUGGESTIONS = 4;

const SYSTEM_PROMPT = `You help a guest who is ON A PHONE CALL with a hotel receptionist. Given the receptionist's most recent line, suggest 1-3 short things the guest could say next. This is a demo, so the guest should NEVER be left without something to say - always return at least one ready reply.

Return ONLY JSON, no markdown fences, in exactly this shape:
{"suggestions": [{"label": "<=3 words for a button", "value": "the exact words the guest speaks"}]}

How to choose replies:
- Phrase "value" as a natural first-person guest utterance (e.g. "Non-smoking, please.").
- If the receptionist offered explicit choices (yes/no, listed room types, listed times), suggest from those.
- If the receptionist asks for the guest's OWN details - name, email, phone, card - just make one up so the guest can say it. Use obviously-fake demo values: a name like "Alex Morgan", an address at example.com for email, a 555 phone number like "415-555-0142", and the test card "4242 4242 4242 4242".
- Do NOT invent facts the HOTEL controls that weren't stated - real prices, room types not offered, availability, or confirmation codes. If unsure there, suggest a neutral reply like "Yes, that works" or a short clarifying question instead.
- Always return at least one suggestion; never return an empty list.
`;

const EXPRESSIVE_GUIDANCE = `
Expressive demo mode:
- Give the receptionist a clear emotion to respond to at every turn. Put the emotion in the guest's words, not only in the button label.
- For an open-ended greeting, introduce varied situations such as:
  - distressed: "My flight was cancelled and I have nowhere to sleep tonight."
  - excited: "It's my birthday and I'm so excited to celebrate!"
  - nervous: "I'm proposing tonight and I really want everything to be perfect."
- Once a situation is established, continue its emotional thread instead of inventing a new story. Even practical answers should carry it naturally: "It's Alex Morgan - thank you, I'm so relieved."
- Offer a mix of believable emotions across suggestions, without inventing hotel facts.
`;

type Suggestion = {
  label: string;
  value: string;
};

/** Watches an AgentSession and publishes per-turn reply suggestions. */
export class SuggestedReplies {
  private readonly systemPrompt: string;
  private abortController?: AbortController;
  private stream?: llm.LLMStream;

  constructor(
    private readonly session: voice.AgentSession,
    private readonly room: Room,
    private readonly model: llm.LLM,
    { expressive = false }: { expressive?: boolean } = {},
  ) {
    this.systemPrompt = SYSTEM_PROMPT + (expressive ? EXPRESSIVE_GUIDANCE : '');
  }

  /** Subscribe to the session. Returns self so it reads as one expression. */
  attach(): SuggestedReplies {
    this.session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      const item = event.item;
      if (!(item instanceof llm.ChatMessage) || item.role !== 'assistant') return;

      this.abortController?.abort();
      this.stream?.close();
      this.abortController = new AbortController();
      void this.run(item.textContent ?? '', this.abortController.signal);
    });
    return this;
  }

  private async run(assistantLine: string, signal: AbortSignal): Promise<void> {
    try {
      await this.suggest(assistantLine, signal);
    } catch (error) {
      if (signal.aborted) return;
      logger.error({ error }, 'suggested-reply generation failed');
      await this.publish([]);
    }
  }

  private async suggest(assistantLine: string, signal: AbortSignal): Promise<void> {
    await this.publish([]);

    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: 'system', content: this.systemPrompt });
    chatCtx.addMessage({
      role: 'user',
      content: `The receptionist just said: "${assistantLine}"`,
    });

    const stream = this.model.chat({ chatCtx });
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

    if (!signal.aborted) await this.publish(parse(raw));
  }

  private async publish(items: Suggestion[]): Promise<void> {
    await this.room.localParticipant!.setAttributes({
      [SUGGESTIONS_ATTRIBUTE]: JSON.stringify(items),
    });
  }
}

function parse(raw: string): Suggestion[] {
  const data = loads(raw);
  const items = isRecord(data) ? data.suggestions : data;
  if (!Array.isArray(items)) return [];

  const clean: Suggestion[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const { label, value } = item;
    if (typeof label === 'string' && typeof value === 'string' && label.trim() && value.trim()) {
      clean.push({ label: label.trim(), value: value.trim() });
    }
  }
  return clean.slice(0, MAX_SUGGESTIONS);
}

function loads(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        // Fall through to an empty result.
      }
    }
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
