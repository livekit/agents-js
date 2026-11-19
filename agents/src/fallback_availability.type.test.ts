// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expectTypeOf, it } from 'vitest';
import type { llm, stt, tts } from './index.js';

describe('availability events of the fallback adapters', () => {
  it('are typed on the adapters, so a listener needs no cast', () => {
    // never called: the listener types are what is checked
    const listen = (
      ttsAdapter: tts.FallbackAdapter,
      sttAdapter: stt.FallbackAdapter,
      llmAdapter: llm.FallbackAdapter,
    ) => {
      ttsAdapter.on('tts_availability_changed', (event) => {
        expectTypeOf(event).toEqualTypeOf<tts.AvailabilityChangedEvent>();
        expectTypeOf(event.tts).toEqualTypeOf<tts.TTS>();
        expectTypeOf(event.available).toEqualTypeOf<boolean>();
      });
      sttAdapter.on('stt_availability_changed', (event) => {
        expectTypeOf(event).toEqualTypeOf<stt.AvailabilityChangedEvent>();
        expectTypeOf(event.stt).toEqualTypeOf<stt.STT>();
      });
      llmAdapter.on('llm_availability_changed', (event) => {
        expectTypeOf(event).toEqualTypeOf<llm.AvailabilityChangedEvent>();
        expectTypeOf(event.llm).toEqualTypeOf<llm.LLM>();
      });
    };
    expectTypeOf(listen).toBeFunction();
  });
});
