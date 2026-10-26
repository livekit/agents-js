// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expectTypeOf, it } from 'vitest';
import type { RealtimeCapabilities } from './realtime.js';

describe('RealtimeCapabilities', () => {
  it('accepts the released native transcript synchronization capability', () => {
    const capabilities: RealtimeCapabilities = {
      messageTruncation: true,
      turnDetection: true,
      userTranscription: true,
      autoToolReplyGeneration: true,
      audioOutput: true,
      manualFunctionCalls: true,
      nativeTranscriptSync: true,
    };

    expectTypeOf(capabilities.nativeTranscriptSync).toEqualTypeOf<boolean | undefined>();
  });
});
