// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { expectTypeOf, it } from 'vitest';
import type { RealtimeSession } from './realtime_model.js';

it('accepts session speed and VAD configuration without enabling or disabling VAD', () => {
  expectTypeOf<RealtimeSession['updateOptions']>().toBeCallableWith({ speed: 0.8 });
  expectTypeOf<RealtimeSession['updateOptions']>().toBeCallableWith({
    turnDetection: { type: 'server_vad', create_response: false },
  });
  // @ts-expect-error Enabling or disabling VAD requires a new session.
  expectTypeOf<RealtimeSession['updateOptions']>().toBeCallableWith({ turnDetection: null });
});
