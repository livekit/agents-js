// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { TTS as InferenceTTS } from '../inference/tts.js';
import { Agent } from './agent.js';
import { AgentActivity } from './agent_activity.js';
import { AgentSession, type ExpressiveOptions } from './agent_session.js';

/** Any value replaces any other; an update that omits `expressive` leaves it alone. */
const APPENDED: ExpressiveOptions = { ttsInstructionsAppend: 'Stay upbeat.' };

describe('expressive dynamic updates', () => {
  it('updates AgentSession expressive options', () => {
    const session = new AgentSession({ expressive: true });
    expect(session._expressive).toBe(true);

    session.updateOptions({ expressive: false });
    expect(session._expressive).toBe(false);

    session.updateOptions({ expressive: APPENDED });
    expect(session._expressive).toBe(APPENDED);

    session.updateOptions();
    expect(session._expressive).toBe(APPENDED);
  });

  it('updates Agent expressive options', async () => {
    expect(new Agent({ instructions: 'test' }).expressive).toBeUndefined();

    const agent = new Agent({ instructions: 'test', expressive: true });
    expect(agent.expressive).toBe(true);

    await agent.updateOptions({ expressive: false });
    expect(agent.expressive).toBe(false);

    await agent.updateOptions({ expressive: APPENDED });
    expect(agent.expressive).toBe(APPENDED);

    await agent.updateOptions();
    expect(agent.expressive).toBe(APPENDED);
  });

  it('prefers Agent expressive options over AgentSession options', async () => {
    const tts = new InferenceTTS({
      model: 'fishaudio/s2.1-pro',
      apiKey: 'fake',
      apiSecret: 'fake',
    });
    const sessionOn = new AgentSession({ expressive: true, tts });
    const sessionOff = new AgentSession({ tts });
    const resolves = (expressive: boolean | undefined, session: AgentSession) =>
      new AgentActivity(
        new Agent({ instructions: 'test', expressive }),
        session,
      )._resolveExpressiveOptions() !== undefined;

    // an agent-level value wins in both directions; `undefined` inherits the session's
    expect(resolves(undefined, sessionOn)).toBe(true);
    expect(resolves(undefined, sessionOff)).toBe(false);
    expect(resolves(false, sessionOn)).toBe(false);
    expect(resolves(true, sessionOff)).toBe(true);

    await Promise.all([sessionOn.close(), sessionOff.close()]);
  });
});
