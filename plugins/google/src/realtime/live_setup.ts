// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { HistoryConfig } from '@google/genai';

/**
 * Structural mirror of the websocket types `@google/genai` uses internally.
 * They are declared but not exported by the package.
 */
interface GenAIWebSocket {
  connect(): void;
  send(message: string): void;
  close(): void;
}

interface GenAIWebSocketFactory {
  create(...args: never[]): GenAIWebSocket;
}

/** The part of `GoogleGenAI` that owns the socket `live.connect()` opens. */
export interface LiveSocketHost {
  live: { webSocketFactory?: GenAIWebSocketFactory };
}

/**
 * Adds `historyConfig` to the setup frame of every session opened on `client`.
 *
 * `historyConfig` is the only way to seed a Gemini Live session with real
 * `user`/`model` roles: it makes the server treat the leading `clientContent`
 * as history rather than as a turn to answer, which the 3.x live models
 * otherwise reject. The field exists on `LiveClientSetup`, but
 * `live.connect()` rebuilds that frame from a fixed whitelist of
 * `LiveConnectConfig` fields which omits it, so setting it on the connect
 * config alone is silently dropped. Splice it into the frame instead.
 *
 * Remove once https://github.com/googleapis/js-genai/issues/1448 ships; the
 * companion test asserts the field is still dropped without this hook.
 *
 * `getHistoryConfig` is consulted once per connection, so reconnects pick up
 * the chat context as it stands at that point. Returning `undefined` leaves
 * the frame untouched.
 *
 * @returns whether the hook could be installed.
 */
export function forwardHistoryConfigToSetup(
  client: LiveSocketHost,
  getHistoryConfig: () => HistoryConfig | undefined,
): boolean {
  const factory = client.live.webSocketFactory;
  if (!factory) {
    return false;
  }

  const createSocket = factory.create.bind(factory);
  factory.create = (...args: never[]) => {
    const socket = createSocket(...args);
    const historyConfig = getHistoryConfig();
    if (!historyConfig) {
      return socket;
    }

    const send = socket.send.bind(socket);
    let setupSent = false;
    socket.send = (message: string) => {
      if (setupSent) {
        return send(message);
      }
      setupSent = true;
      return send(withHistoryConfig(message, historyConfig));
    };
    return socket;
  };

  return true;
}

/**
 * Decides whether a session's initial chat context has to be seeded through
 * `historyConfig`.
 *
 * Models that accept mid-session context updates also accept a plain
 * `clientContent` prefill containing `model` turns, so they need nothing extra.
 * The 3.x live models close the socket on such a prefill, and seeding them
 * needs the server to be told up front that the leading `clientContent` is
 * history. With no history to seed there is nothing for the server to wait for.
 */
export function historyConfigForSetup(session: {
  mutableChatCtx: boolean;
  hasInitialHistory: boolean;
}): HistoryConfig | undefined {
  if (session.mutableChatCtx || !session.hasInitialHistory) {
    return undefined;
  }
  return { initialHistoryInClientContent: true };
}

function withHistoryConfig(frame: string, historyConfig: HistoryConfig): string {
  const parsed = JSON.parse(frame);
  parsed.setup = { ...parsed.setup, historyConfig };
  return JSON.stringify(parsed);
}
