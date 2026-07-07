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

export function deserializeChat(payload: string): MeetingChatMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }

  if (!obj || typeof obj !== 'object' || (obj as { type?: unknown }).type !== 'chat') {
    return null;
  }

  const { sender, text, to } = obj as { sender?: unknown; text?: unknown; to?: unknown };
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }

  return {
    sender: typeof sender === 'string' && sender.trim() ? sender.trim() : 'Someone',
    text: text.trim(),
    ...(typeof to === 'string' && to.trim() ? { to: to.trim() } : {}),
  };
}
