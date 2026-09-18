import { inference } from '@livekit/agents';

// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
export * from './api_proto.js';
export * from './realtime_model.js';
export * from './gpt_live_model.js';
export * as GPTLive from './gpt_live_types.js';

/** @deprecated Use `inference.RealtimeModel` from `@livekit/agents`. */
export const InferenceRealtimeModel = inference.RealtimeModel;
/** @deprecated Use `inference.RealtimeSession` from `@livekit/agents`. */
export const InferenceRealtimeSession = inference.RealtimeSession;
