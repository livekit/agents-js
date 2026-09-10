// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expectTypeOf, it } from 'vitest';
import type { DuplexOutputTranscriptDelta } from './duplex.js';
import { DuplexSession, type DuplexSessionCallbacks } from './index.js';
import type { InputTranscriptionCompleted } from './realtime.js';

type ProviderCallbacks = {
  provider_state: (state: 'listening' | 'speaking') => void;
};

abstract class ProviderSession extends DuplexSession<ProviderCallbacks> {
  checkEventTypes(): void {
    this.emit('transcript_delta', { text: 'hello' });
    this.on('transcript_delta', (event) => {
      expectTypeOf(event).toEqualTypeOf<DuplexOutputTranscriptDelta>();
    });
    this.on('input_audio_transcription_completed', (event) => {
      expectTypeOf(event).toEqualTypeOf<InputTranscriptionCompleted>();
    });
    this.emit('provider_state', 'listening');
    this.on('provider_state', (state) => {
      expectTypeOf(state).toEqualTypeOf<'listening' | 'speaking'>();
    });

    // @ts-expect-error Event names must match the callback map.
    this.emit('transcript_dleta', { text: 'hello' });
    // @ts-expect-error Function calls require the FunctionCall payload.
    this.emit('function_call', { text: 'hello' });
    // @ts-expect-error The event name selects the listener's payload type.
    this.on('input_audio_transcription_completed', (event: number) => event.toFixed());
    // @ts-expect-error Provider-specific payloads are also checked.
    this.emit('provider_state', 42);
    // @ts-expect-error Metrics require the RealtimeModelMetrics payload.
    this.emit('metrics_collected', { wrong: true });
  }
}

describe('DuplexSession events', () => {
  it('limits base sessions to the standard callbacks', () => {
    expectTypeOf<DuplexSession['on']>().parameter(0).toEqualTypeOf<keyof DuplexSessionCallbacks>();
  });

  it('accepts provider sessions with additional typed callbacks', () => {
    expectTypeOf<ProviderSession>().toExtend<DuplexSession>();
  });
});
