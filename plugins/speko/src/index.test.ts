// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('public exports', () => {
  let publicExports: Record<string, unknown>;

  beforeAll(async () => {
    vi.stubGlobal('__PACKAGE_NAME__', '@livekit/agents-plugin-speko');
    vi.stubGlobal('__PACKAGE_VERSION__', '0.0.0-test');
    publicExports = (await import('./index.js')) as unknown as Record<string, unknown>;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('exposes LiveKit-style namespace constructors', () => {
    expect(publicExports.LLM).toBeTypeOf('function');
    expect(publicExports.STT).toBeTypeOf('function');
    expect(publicExports.TTS).toBeTypeOf('function');
  });

  it('does not expose draft Speko-prefixed component aliases', () => {
    expect(publicExports.SpekoLLM).toBeUndefined();
    expect(publicExports.SpekoSTT).toBeUndefined();
    expect(publicExports.SpekoTTS).toBeUndefined();
  });

  it('does not expose a Speko-specific component factory', () => {
    expect(publicExports.createSpekoComponents).toBeUndefined();
  });
});
