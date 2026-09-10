// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expectTypeOf, it } from 'vitest';
import { type FallbackActivatedEvent, TTS } from './index.js';

describe('Inference TTS event types', () => {
  it('types fallback activation listeners', () => {
    const tts = new TTS({
      model: 'cartesia/sonic',
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      disableSystemDefaultFallback: true,
    });

    tts.on('fallback_activated', (event) => {
      expectTypeOf(event).toEqualTypeOf<FallbackActivatedEvent>();
      expectTypeOf(event.sessionId).toEqualTypeOf<string>();
      expectTypeOf(event.fallbackType).toEqualTypeOf<'unknown' | 'fallback' | 'system_default'>();
      expectTypeOf(event.cause).toEqualTypeOf<
        'unknown' | 'timeout' | 'canceled' | 'provider_error' | 'quota_exceeded'
      >();
    });

    // @ts-expect-error Unknown TTS events must not be accepted.
    tts.on('future_gateway_event', () => {});

    tts.updateOptions({
      // @ts-expect-error The system fallback opt-out is constructor-only.
      disableSystemDefaultFallback: false,
    });
  });
});
