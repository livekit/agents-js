// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, it } from 'vitest';
import type { ConnectionPoolOptions } from './connection_pool.js';

const connectCb = async (_timeout: number): Promise<string> => 'connected';

const optionalErrorOptions: ConnectionPoolOptions<string> = {
  connectCb,
  connectionError: (error?: Error) => error ?? new Error('connection failed'),
};

const omittedErrorOptions: ConnectionPoolOptions<string> = {
  connectCb,
  connectionError: () => new Error('connection failed'),
};

describe('ConnectionPool API compatibility', () => {
  it('accepts connectionError callbacks with optional or omitted errors', () => {
    void optionalErrorOptions;
    void omittedErrorOptions;
  });
});
