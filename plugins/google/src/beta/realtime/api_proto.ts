// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';

/**
 * Supported Google Live API models
 */
export type LiveAPIModels =
  | 'gemini-2.0-flash-exp'
  // models supported on Gemini API
  | 'gemini-2.0-flash-live-001'
  | 'gemini-2.5-flash-preview-native-audio-dialog'
  | 'gemini-2.5-flash-exp-native-audio-thinking-dialog';

/**
 * Available voice options for Google Realtime API
 */
export type Voice = 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Aoede' | 'Leda' | 'Orus' | 'Zephyr';

/**
 * Union type for all possible client events
 */

export type ClientEvents =
  | {
      type: 'content';
      value: types.LiveClientContent;
    }
  | {
      type: 'realtime_input';
      value: types.LiveClientRealtimeInput;
    }
  | {
      type: 'tool_response';
      value: types.LiveClientToolResponse;
    }
  | {
      type: 'function_response';
      value: types.FunctionResponse;
    };
