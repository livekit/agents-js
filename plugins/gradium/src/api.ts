// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Attribute every Gradium websocket to this plugin instead of direct API traffic.
const API_SOURCE = 'livekit-plugin';

export function wsHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'x-api-source': API_SOURCE };
}
