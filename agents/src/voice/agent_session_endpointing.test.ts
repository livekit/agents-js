// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for detector-aware endpointing defaults on `AgentSession`.
 *
 * Port of the seven test additions on `tests/test_agent_session.py` from
 * livekit/agents PR #4722 (commits `c72938` and `2328f3`):
 *
 * - `test_streaming_detector_uses_streaming_endpointing_defaults`
 * - `test_non_streaming_detector_uses_legacy_endpointing_defaults`
 * - `test_explicit_endpointing_overrides_streaming_default_per_key`
 * - `test_user_streaming_detector_uses_streaming_defaults`
 * - `test_deprecated_turn_detection_vad_uses_legacy_defaults`
 * - `test_agent_turn_detection_override_resolves_endpointing_per_activity`
 * - `test_runtime_endpointing_opts_survive_handoff`
 *
 * Python uses seconds; JS uses milliseconds (0.3s→300, 2.5s→2500, 0.5s→500, 3.0s→3000).
 */
import { describe, expect, it } from 'vitest';
import { TurnDetector } from '../inference/eot/detector.js';
import type { VADStream } from '../vad.js';
import { VAD as BaseVAD } from '../vad.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
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

describe('AgentSession endpointing defaults', () => {
  it('default session (streaming detector) uses the tighter streaming defaults', async () => {
    const session = new AgentSession();
    try {
      expect(session.sessionOptions.turnHandling.endpointing.minDelay).toBe(300);
      expect(session.sessionOptions.turnHandling.endpointing.maxDelay).toBe(2500);
      expect(session.sessionOptions.turnHandling.endpointingOverrides).toEqual({});
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('a non-streaming mode keeps the legacy defaults', async () => {
    const session = new AgentSession({ turnHandling: { turnDetection: 'vad' } });
    try {
      expect(session.sessionOptions.turnHandling.endpointing.minDelay).toBe(500);
      expect(session.sessionOptions.turnHandling.endpointing.maxDelay).toBe(3000);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('an explicit delay is honored; the unset one still gets the streaming default', async () => {
    const session = new AgentSession({ turnHandling: { endpointing: { minDelay: 400 } } });
    try {
      expect(session.sessionOptions.turnHandling.endpointing.minDelay).toBe(400);
      expect(session.sessionOptions.turnHandling.endpointing.maxDelay).toBe(2500);
      expect(session.sessionOptions.turnHandling.endpointingOverrides).toEqual({ minDelay: 400 });
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('a user-constructed streaming detector also triggers the streaming defaults', async () => {
    const session = new AgentSession({
      turnHandling: { turnDetection: new TurnDetector({ version: 'v1-mini' }) },
    });
    try {
      expect(session.sessionOptions.turnHandling.endpointing.minDelay).toBe(300);
      expect(session.sessionOptions.turnHandling.endpointing.maxDelay).toBe(2500);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('deprecated top-level turnDetection + no delays → legacy defaults', async () => {
    const session = new AgentSession({ turnDetection: 'vad' });
    try {
      expect(session.sessionOptions.turnHandling.endpointing.minDelay).toBe(500);
      expect(session.sessionOptions.turnHandling.endpointing.maxDelay).toBe(3000);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('endpointingOpts uses the activity-resolved detector, not just the session', async () => {
    // session default → streaming detector; provide a VAD so the detector validates
    const session = new AgentSession({ vad: new FakeVAD() });
    try {
      const streamingActivity = new AgentActivity(new Agent({ instructions: 'test' }), session);
      expect(streamingActivity.endpointingOpts.minDelay).toBe(300);
      expect(streamingActivity.endpointingOpts.maxDelay).toBe(2500);

      // an agent overriding to VAD falls back to legacy defaults for this activity
      const vadActivity = new AgentActivity(
        new Agent({ instructions: 'test', turnDetection: 'vad' }),
        session,
      );
      expect(vadActivity.endpointingOpts.minDelay).toBe(500);
      expect(vadActivity.endpointingOpts.maxDelay).toBe(3000);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it('runtime updateOptions changes survive a handoff via overrides', async () => {
    const session = new AgentSession({ vad: new FakeVAD() });
    try {
      session.updateOptions({
        turnHandling: { endpointing: { mode: 'dynamic', alpha: 0.5, minDelay: 400 } },
      });

      // a fresh activity (as built on agent handoff) re-resolves from overrides
      const activity = new AgentActivity(new Agent({ instructions: 'test' }), session);
      expect(activity.endpointingOpts.mode).toBe('dynamic');
      expect(activity.endpointingOpts.alpha).toBe(0.5);
      expect(activity.endpointingOpts.minDelay).toBe(400);
      // untouched key still gets the streaming default
      expect(activity.endpointingOpts.maxDelay).toBe(2500);
    } finally {
      await session.close().catch(() => {});
    }
  });
});
