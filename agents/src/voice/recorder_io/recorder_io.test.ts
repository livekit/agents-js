// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { isWritableStreamClosedError } from '../../utils.js';

describe('RecorderIO writable stream error detection', () => {
  it('detects ERR_INVALID_STATE stream closure errors', () => {
    const err = new TypeError('Invalid state: WritableStream is closed');
    Object.assign(err, { code: 'ERR_INVALID_STATE' });

    expect(isWritableStreamClosedError(err)).toBe(true);
  });

  it('detects writable stream closed errors by message', () => {
    const err = new TypeError('Invalid state: WritableStream is closed');

    expect(isWritableStreamClosedError(err)).toBe(true);
  });

  it('does not treat unrelated errors as stream closure', () => {
    const err = new Error('network timeout');

    expect(isWritableStreamClosedError(err)).toBe(false);
  });
});
