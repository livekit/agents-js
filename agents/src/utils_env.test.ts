// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the `resolveEnvVar` helper contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveEnvVar } from './utils.js';

const ENV_KEYS = ['LIVEKIT_INFERENCE_URL', 'LIVEKIT_URL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveEnvVar', () => {
  it('returns empty string when no env or default', () => {
    expect(resolveEnvVar(undefined, ['LIVEKIT_INFERENCE_URL'])).toBe('');
  });

  it('returns default when no matching env exists', () => {
    expect(resolveEnvVar(undefined, ['LIVEKIT_INFERENCE_URL'], 'https://default.example.com')).toBe(
      'https://default.example.com',
    );
  });

  it('returns first matching env value', () => {
    process.env.LIVEKIT_INFERENCE_URL = 'https://inference.example.com';
    process.env.LIVEKIT_URL = 'https://livekit.example.com';
    expect(
      resolveEnvVar(
        undefined,
        ['LIVEKIT_INFERENCE_URL', 'LIVEKIT_URL'],
        'https://default.example.com',
      ),
    ).toBe('https://inference.example.com');
  });

  it('falls back to later env when earlier env missing', () => {
    process.env.LIVEKIT_URL = 'https://livekit.example.com';
    expect(
      resolveEnvVar(
        undefined,
        ['LIVEKIT_INFERENCE_URL', 'LIVEKIT_URL'],
        'https://default.example.com',
      ),
    ).toBe('https://livekit.example.com');
  });

  it('prefers explicit value over environment', () => {
    process.env.LIVEKIT_INFERENCE_URL = 'https://env.example.com';
    expect(
      resolveEnvVar(
        'https://explicit.example.com',
        ['LIVEKIT_INFERENCE_URL'],
        'https://default.example.com',
      ),
    ).toBe('https://explicit.example.com');
  });

  it('treats empty env value as missing', () => {
    process.env.LIVEKIT_INFERENCE_URL = '';
    expect(resolveEnvVar(undefined, ['LIVEKIT_INFERENCE_URL'], 'https://default.example.com')).toBe(
      'https://default.example.com',
    );
  });

  it('treats whitespace env value as set', () => {
    process.env.LIVEKIT_INFERENCE_URL = ' ';
    expect(resolveEnvVar(undefined, ['LIVEKIT_INFERENCE_URL'], 'https://default.example.com')).toBe(
      ' ',
    );
  });
});
