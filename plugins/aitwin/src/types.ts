// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Default LiveKit text topic used for Ai Twin speakText() in the browser. */
export const DEFAULT_TOPIC_SPEAK = 'aitwin.speak';

export type AiTwinSpeechOptions = {
  /**
   * LiveKit text stream topic the agent publishes reply text on.
   * The browser should register a handler for this topic and call speakText().
   * @defaultValue aitwin.speak
   */
  topic?: string;
};

export type MintAiTwinAuthTokenOptions = {
  clientId?: string;
  clientSecret?: string;
  userId: string;
  userName?: string;
  /** Token lifetime in seconds. @defaultValue 3600 */
  expiresIn?: number;
  authTokenUrl?: string;
};

export type MintAiTwinAuthTokenResult = {
  authToken: string;
};
