// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the bundled-default VAD behavior on `AgentSession`.
 *
 * Port of three test additions on `tests/test_agent_session.py`:
 *
 * - `test_default_vad_is_auto_provisioned`
 * - `test_explicit_vad_none_opts_out`
 * - `test_user_supplied_vad_keeps_is_default_false`
 */
import { describe, expect, it } from 'vitest';
import type { VADStream } from '../vad.js';
import { VAD as BaseVAD } from '../vad.js';
import { AgentSession } from './agent_session.js';

class FakeVAD extends BaseVAD {
  label = 'FakeVAD';
  constructor() {
    super({ updateInterval: 32 });
  }
  stream(): VADStream {
    throw new Error('not used in this test');
  }
}

describe('AgentSession default VAD', () => {
  it('auto-provisions a default VAD when none passed', async () => {
    const session = new AgentSession();
    try {
      expect(session.vad).toBeDefined();
      expect(session.vad?.isDefault).toBe(true);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('explicit `vad: null` opts out', async () => {
    const session = new AgentSession({ vad: null });
    try {
      expect(session.vad).toBeUndefined();
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('user-supplied VAD keeps isDefault false', async () => {
    const userVad = new FakeVAD();
    expect(userVad.isDefault).toBe(false);
    const session = new AgentSession({ vad: userVad });
    try {
      expect(session.vad).toBe(userVad);
      expect(session.vad?.isDefault).toBe(false);
    } finally {
      await session.close().catch(() => {});
    }
  });
});
