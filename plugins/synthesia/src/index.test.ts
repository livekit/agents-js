// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { Plugin } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { AvatarConfig, ErrorType, SynthesiaError } from './index.js';

describe('Synthesia plugin and config', () => {
  it('registers the plugin and exports its error taxonomy', () => {
    expect(Plugin.registeredPlugins.some((plugin) => plugin.title === 'synthesia')).toBe(true);
    expect(ErrorType.UNKNOWN_AVATAR).toBe('unknown_avatar');
    expect(new SynthesiaError('x')).toBeInstanceOf(SynthesiaError);
  });

  it.each([0, 6])('rejects %i avatar IDs', (length) => {
    expect(
      () => new AvatarConfig({ avatarIds: Array.from({ length }, (_, i) => `a-${i}`) }),
    ).toThrow('between 1 and 5');
  });

  it('rejects a bare string and copies the input while preserving order', () => {
    expect(() => new AvatarConfig({ avatarIds: 'lucas' as unknown as string[] })).toThrow('list');
    const ids = ['first', 'second'];
    const config = new AvatarConfig({ avatarIds: ids });
    ids.push('third');
    expect(config.avatarIds).toEqual(['first', 'second']);
  });
});
