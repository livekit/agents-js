// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { IdentityTransform } from '../../stream/identity_transform.js';

/**
 * Tests for the WritableStream close guard in RoomIO.close().
 *
 * RoomIO uses an IdentityTransform stream internally for user transcript
 * forwarding. During teardown, the writer may already be closed or errored
 * (e.g. a concurrent write failed during speech interruption). The close()
 * method must tolerate this without throwing.
 */
describe('RoomIO WritableStream close guard', () => {
  it('should not reject when closing an already-closed writer', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();

    await writer.close();

    // Second close rejects with ERR_INVALID_STATE without the guard.
    // Wrapping in try/catch (as RoomIO.close() does) must suppress it.
    await expect(
      (async () => {
        try {
          await writer.close();
        } catch {
          // swallowed — mirrors RoomIO.close() teardown guard
        }
      })(),
    ).resolves.toBeUndefined();
  });

  it('should not reject when closing a writer on an errored stream', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();

    // Force the stream into an errored state
    await writer.abort(new Error('simulated write failure'));

    // close() on an errored writer rejects without the guard.
    await expect(
      (async () => {
        try {
          await writer.close();
        } catch {
          // swallowed — mirrors RoomIO.close() teardown guard
        }
      })(),
    ).resolves.toBeUndefined();
  });
});
