// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';

/**
 * Supported Google Live API models
 *
 * Gemini API deprecations: https://ai.google.dev/gemini-api/docs/deprecations
 * Gemini API release notes with preview deprecations: https://ai.google.dev/gemini-api/docs/changelog
 * Live models: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api
 * VertexAI retirement: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions#retired-models
 * Additional references:
 * 1. https://github.com/kazunori279/adk-streaming-test/blob/main/test_report.md
 */
export type LiveAPIModels =
  // VertexAI models
  | 'gemini-live-2.5-flash-native-audio' // GA https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-live-api#live-2.5-flash
  | 'gemini-live-2.5-flash-preview-native-audio-09-2025' // Public preview https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-live-api#live-2.5-flash-preview
  | 'gemini-live-2.5-flash-preview-native-audio' // still works, possibly an alias, but not mentioned in any docs or changelog
  // Gemini API models
  | 'gemini-2.5-flash-native-audio-preview-12-2025' // https://ai.google.dev/gemini-api/docs/models#gemini-2.5-flash-live
  | 'gemini-2.5-flash-native-audio-preview-09-2025' // https://ai.google.dev/gemini-api/docs/models#gemini-2.5-flash-live
  | 'gemini-2.0-flash-exp'; // still works in Gemini API but not VertexAI

/**
 * Available voice options for Google Realtime API
 */
export type Voice =
  | 'Achernar'
  | 'Achird'
  | 'Algenib'
  | 'Algieba'
  | 'Alnilam'
  | 'Aoede'
  | 'Autonoe'
  | 'Callirrhoe'
  | 'Charon'
  | 'Despina'
  | 'Enceladus'
  | 'Erinome'
  | 'Fenrir'
  | 'Gacrux'
  | 'Iapetus'
  | 'Kore'
  | 'Laomedeia'
  | 'Leda'
  | 'Orus'
  | 'Pulcherrima'
  | 'Puck'
  | 'Rasalgethi'
  | 'Sadachbia'
  | 'Sadaltager'
  | 'Schedar'
  | 'Sulafat'
  | 'Umbriel'
  | 'Vindemiatrix'
  | 'Zephyr'
  | 'Zubenelgenubi';

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
