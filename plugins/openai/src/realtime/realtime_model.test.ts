// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { inference } from '@livekit/agents';
import type { RealtimeModels as CoreRealtimeModels } from '@livekit/agents/llm/openai_realtime/api_proto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { RealtimeModels as PluginRealtimeModels } from '../models.js';
import {
  InferenceRealtimeModel,
  InferenceRealtimeSession,
  RealtimeModel,
  RealtimeSession,
} from './index.js';

describe('OpenAI realtime compatibility exports', () => {
  it('keeps hosted inference imports canonical', () => {
    expect(InferenceRealtimeModel).toBe(inference.RealtimeModel);
    expect(InferenceRealtimeSession).toBe(inference.RealtimeSession);
  });

  it('preserves the direct model label and model types', () => {
    const model = new RealtimeModel({ apiKey: 'fake' });

    expect(model.label()).toBe('openai.RealtimeModel');
    expectTypeOf<PluginRealtimeModels>().toEqualTypeOf<CoreRealtimeModels>();
    expect(RealtimeSession).toBeDefined();
  });
});
