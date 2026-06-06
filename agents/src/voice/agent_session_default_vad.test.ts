// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the bundled-default VAD and turn-detection behavior on `AgentSession`.
 *
 * Port of six test additions on `tests/test_agent_session.py`:
 *
 * - `test_default_vad_is_auto_provisioned`
 * - `test_explicit_vad_none_opts_out`
 * - `test_user_supplied_vad_keeps_using_default_false`
 * - `test_default_turn_detection_builds_default_eot`
 * - `test_turn_detection_none_opts_out`
 * - `test_user_supplied_turn_detector_passes_through`
 */
import { describe, expect, it } from 'vitest';
import { TurnDetector } from '../inference/eot/detector.js';
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
      expect(session._usingDefaultVad).toBe(true);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('explicit `vad: null` opts out', async () => {
    const session = new AgentSession({ vad: null });
    try {
      expect(session.vad).toBeUndefined();
      expect(session._usingDefaultVad).toBe(false);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('user-supplied VAD keeps _usingDefaultVad false', async () => {
    const userVad = new FakeVAD();
    const session = new AgentSession({ vad: userVad });
    try {
      expect(session.vad).toBe(userVad);
      expect(session._usingDefaultVad).toBe(false);
    } finally {
      await session.close().catch(() => {});
    }
  });
});

describe('AgentSession default turn detection', () => {
  it('auto-provisions a default TurnDetector when none given', async () => {
    const session = new AgentSession();
    try {
      expect(session.turnDetection).toBeInstanceOf(TurnDetector);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('explicit `turnDetection: null` opts out (no default detector built)', async () => {
    // `null` is the explicit opt-out, distinct from `undefined` (not given);
    // mirrors Python `turn_detection=None`.
    const session = new AgentSession({ turnHandling: { turnDetection: null } });
    try {
      expect(session.turnDetection).toBeUndefined();
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('passes a user-supplied turn detector through unchanged', async () => {
    const userDetector = new TurnDetector({ version: 'v1-mini' });
    const session = new AgentSession({ turnHandling: { turnDetection: userDetector } });
    try {
      expect(session.turnDetection).toBe(userDetector);
    } finally {
      await session.close().catch(() => {});
    }
  });
});
