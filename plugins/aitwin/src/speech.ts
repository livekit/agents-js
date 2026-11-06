// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { llm, log, voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';

import { DEFAULT_TOPIC_SPEAK, type AiTwinSpeechOptions } from './types.js';

function extractAssistantText(item: llm.ChatMessage): string {
  const direct = (item.textContent ?? '').trim();
  if (direct) return direct;

  const parts: string[] = [];
  for (const content of item.content ?? []) {
    if (typeof content === 'string') {
      const t = content.trim();
      if (t) parts.push(t);
    } else if (
      content &&
      typeof content === 'object' &&
      'type' in content &&
      (content as { type?: string }).type === 'text' &&
      'text' in content
    ) {
      const t = String((content as { text?: string }).text ?? '').trim();
      if (t) parts.push(t);
    }
  }
  return parts.join(' ').trim();
}

/**
 * Publish each assistant reply as LiveKit text so the browser can call
 * `@streamoji/aitwin` `speakText()`. Does not join a remote avatar or publish video.
 *
 * Pair with `outputOptions: { audioEnabled: false }` (and no agent TTS) so only
 * Ai Twin speaks in the browser.
 */
export function attachAiTwinSpeech(
  session: voice.AgentSession,
  room: Room,
  options: AiTwinSpeechOptions = {},
): () => void {
  const topic =
    (options.topic ?? process.env.TOPIC_SPEAK ?? DEFAULT_TOPIC_SPEAK).trim() || DEFAULT_TOPIC_SPEAK;
  const logger = log().child({ module: 'AiTwinSpeech', topic });

  const onItem = (ev: voice.ConversationItemAddedEvent) => {
    const item = ev.item;
    if (!(item instanceof llm.ChatMessage) || item.role !== 'assistant') {
      return;
    }

    const text = extractAssistantText(item);
    if (!text) return;

    const participant = room.localParticipant;
    if (!participant) {
      logger.warn('skip publish: room has no local participant');
      return;
    }

    void participant
      .sendText(text, { topic })
      .then(() => {
        logger.info(
          { chars: text.length, preview: text.slice(0, 120) },
          'published Ai Twin speak text',
        );
      })
      .catch((err: unknown) => {
        logger.warn({ err }, 'failed to publish Ai Twin speak text');
      });
  };

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, onItem);

  return () => {
    session.off(voice.AgentSessionEventTypes.ConversationItemAdded, onItem);
  };
}

/**
 * Small helper around {@link attachAiTwinSpeech} for clearer agent entrypoints.
 */
export class AiTwinSpeech {
  readonly topic: string;
  private stopFn: (() => void) | null = null;

  constructor(options: AiTwinSpeechOptions = {}) {
    this.topic =
      (options.topic ?? process.env.TOPIC_SPEAK ?? DEFAULT_TOPIC_SPEAK).trim() || DEFAULT_TOPIC_SPEAK;
  }

  /**
   * Start forwarding assistant replies to the speak topic.
   * Call after you have a room (typically before or right after session.start).
   */
  start(session: voice.AgentSession, room: Room): void {
    this.stop();
    this.stopFn = attachAiTwinSpeech(session, room, { topic: this.topic });
  }

  stop(): void {
    this.stopFn?.();
    this.stopFn = null;
  }
}
