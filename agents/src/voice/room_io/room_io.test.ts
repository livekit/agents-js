// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { IdentityTransform } from '../../stream/identity_transform.js';

/**
 * Regression tests proving WritableStream.close() rejects when the writer is
 * already closed or errored — the exact scenario RoomIO.close() guards against
 * with a try/catch.
 *
 * RoomIO holds a WritableStreamDefaultWriter for user transcript forwarding.
 * During teardown, the writer may already be closed or errored (e.g. a
 * concurrent write failed during speech interruption). Without the guard,
 * close() throws ERR_INVALID_STATE and crashes teardown.
 */
describe('RoomIO WritableStream close guard', () => {
  it('should reject when closing an already-closed writer', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();

    await writer.close();

    // Proves the bug: second close() rejects — RoomIO.close() must guard this.
    await expect(writer.close()).rejects.toThrow();
  });

  it('should reject when closing a writer on an errored stream', async () => {
    const transform = new IdentityTransform<string>();
    const writer = transform.writable.getWriter();

    // Force the stream into an errored state
    await writer.abort(new Error('simulated write failure'));

    // Proves the bug: close() on errored writer rejects — RoomIO.close() must guard this.
    await expect(writer.close()).rejects.toThrow();
  });
});
