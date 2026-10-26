// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Result of adding an active LemonSlice session to an external meeting. */
export interface JoinMeetingResult {
  /** WebSocket URL for mixed meeting audio and chat. */
  websocketUrl: string;
  /** Identifier for the bot instance in the external meeting. */
  meetingBotId: string;
}
