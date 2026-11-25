// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { expectTypeOf, it } from 'vitest';
import type {
  DecisionAvailabilityChangedEvent,
  DecisionModelFallbackAdapter,
} from './decision_fallback_adapter.js';
import type { DecisionModel } from './decisions.js';

it('supports availability listeners and remains assignable to a decision model', () => {
  const event = 'decision_availability_changed';
  const listener = (_event: DecisionAvailabilityChangedEvent) => {};

  expectTypeOf<DecisionModelFallbackAdapter>().toExtend<DecisionModel>();
  expectTypeOf<DecisionModelFallbackAdapter['on']>().toBeCallableWith(event, listener);
  expectTypeOf<DecisionModelFallbackAdapter['off']>().toBeCallableWith(event, listener);
  expectTypeOf<DecisionModelFallbackAdapter['once']>().toBeCallableWith(event, listener);
  expectTypeOf<DecisionModelFallbackAdapter['addListener']>().toBeCallableWith(event, listener);
  expectTypeOf<DecisionModelFallbackAdapter['removeListener']>().toBeCallableWith(event, listener);
  expectTypeOf<DecisionModelFallbackAdapter['listenerCount']>().toBeCallableWith(event);
  // @ts-expect-error Only the adapter emits the availability event.
  expectTypeOf<DecisionModel['once']>().toBeCallableWith(event, listener);
});
