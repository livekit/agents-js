// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Parsed meeting chat message from a relay WebSocket TEXT frame. */
export interface MeetingChatMessage {
  /** Display name of the message sender. */
  sender: string;
  /** Message body text. */
  text: string;
  /** Optional recipient display name for direct messages. */
  to?: string;
}

/** Parse a meeting chat JSON payload from the relay WebSocket. */
export function deserializeChat(payload: string): MeetingChatMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }

  if (typeof obj !== 'object' || obj === null) {
    return null;
  }

  const record = obj as Record<string, unknown>;
  if (record.type !== 'chat') {
    return null;
  }

  const text = record.text;
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }

  const sender = record.sender;
  const to = record.to;

  return {
    sender:
      typeof sender === 'string' && sender.trim() ? sender.trim() : 'Someone',
    text: text.trim(),
    to: typeof to === 'string' && to.trim() ? to.trim() : undefined,
  };
}
