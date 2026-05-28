// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { OptimizeFor, RoutingIntent } from '@spekoai/sdk';

/**
 * Routing hint passed to every Speko proxy call the plugin makes. Mirrors
 * `@spekoai/sdk`'s `RoutingIntent` so that callers can pass a value they got
 * from the SDK directly without a type detour.
 *
 * @public
 */
export type Intent = RoutingIntent;

export type { OptimizeFor };

const OPTIMIZE_FOR: ReadonlySet<OptimizeFor> = new Set(['balanced', 'accuracy', 'latency', 'cost']);

/**
 * Validate an {@link Intent} at construction time so that a broken routing
 * hint throws when the plugin is created, not deep inside the first STT call.
 *
 * @public
 */
export function validateIntent(intent: Intent): void {
  if (!intent.language || typeof intent.language !== 'string') {
    throw new Error('SpekoPlugin: intent.language is required (BCP-47 tag)');
  }
  if (intent.optimizeFor !== undefined && !OPTIMIZE_FOR.has(intent.optimizeFor)) {
    throw new Error(
      `SpekoPlugin: unknown optimizeFor "${intent.optimizeFor}". ` +
        `Expected one of: ${[...OPTIMIZE_FOR].join(', ')}.`,
    );
  }
}
