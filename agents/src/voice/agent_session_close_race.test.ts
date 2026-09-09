// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { Agent } from './agent.js';
import type { AgentActivity } from './agent_activity.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes } from './events.js';

describe('AgentSession close activity race', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('finishes closing the captured activity when the session activity changes during drain', async () => {
    const session = new AgentSession();
    await session.start({ agent: new Agent({ instructions: 'test' }) });

    const internals = session as unknown as { activity?: AgentActivity };
    const activity = internals.activity!;

    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    let markDrainStarted!: () => void;
    const drainStarted = new Promise<void>((resolve) => {
      markDrainStarted = resolve;
    });

    vi.spyOn(activity, 'drain').mockImplementation(async () => {
      markDrainStarted();
      await drainGate;
      return undefined;
    });
    const activityClose = vi.spyOn(activity, 'close');
    const onClose = vi.fn();
    session.on(AgentSessionEventTypes.Close, onClose);

    const closePromise = session.close();
    await drainStarted;

    internals.activity = undefined;
    releaseDrain();

    await expect(closePromise).resolves.toBeUndefined();
    expect(activityClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
