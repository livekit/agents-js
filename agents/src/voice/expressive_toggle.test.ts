// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { TTS as InferenceTTS } from '../inference/tts.js';
import { SentenceTokenizer as BasicSentenceTokenizer } from '../tokenize/basic/index.js';
import type { SentenceTokenizer } from '../tokenize/tokenizer.js';
import { StreamAdapter } from '../tts/stream_adapter.js';
import { TTS } from '../tts/tts.js';
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

/** A TTS that declares the gemini dialect without lowering anything itself. */
class DeclaringTTS extends TTS {
  label = 'test.DeclaringTTS';

  constructor(streaming: boolean) {
    super(24000, 1, { streaming });
  }

  protected override markupProviderKey(): string {
    return 'gemini';
  }

  synthesize(): never {
    throw new Error('not implemented');
  }

  stream(): never {
    throw new Error('not implemented');
  }
}

describe('expressive needs a TTS the framework can lower for', () => {
  const resolves = async (tts: TTS): Promise<boolean> => {
    const session = new AgentSession({ expressive: true, tts });
    try {
      return (
        new AgentActivity(
          new Agent({ instructions: 'test' }),
          session,
        )._resolveExpressiveOptions() !== undefined
      );
    } finally {
      await session.close();
    }
  };

  it('requires something to lower the markers, not just a dialect', async () => {
    // non-streaming: the StreamAdapter the framework wraps it in does the lowering
    expect(await resolves(new DeclaringTTS(false))).toBe(true);
    // natively streaming: nothing in the framework can lower for it
    expect(await resolves(new DeclaringTTS(true))).toBe(false);
    // the gateway streams too, but lowers inside its own stream
    expect(
      await resolves(
        new InferenceTTS({ model: 'fishaudio/s2.1-pro', apiKey: 'fake', apiSecret: 'fake' }),
      ),
    ).toBe(true);
  });

  it('keeps a caller-supplied StreamAdapter expressive', async () => {
    // a StreamAdapter is streaming only at its surface; inside is the lowering path
    const wrapped = new DeclaringTTS(false);
    const adapter = new StreamAdapter(wrapped, new BasicSentenceTokenizer());
    expect(adapter.capabilities.streaming).toBe(true); // what the old guard rejected it for
    expect(adapter.markup.providerKey).toBe('gemini');
    expect(await resolves(adapter)).toBe(true);

    // StreamAdapterWrapper reads the wrapped instance's flag, so it has to pass through
    adapter._setExpressive(true);
    expect(wrapped.expressive).toBe(true);
    await adapter.close();
  });

  it('snapshots expressive per StreamAdapter stream', async () => {
    // the flag lives on the shared TTS, but a stream is one synthesis: the pipeline sets it
    // synchronously before stream(), and run() happens later, so another turn or session
    // sharing the TTS could flip it in the gap and send that turn's markers unlowered
    const wrapped = new DeclaringTTS(false);
    const adapter = new StreamAdapter(wrapped, new BasicSentenceTokenizer());

    adapter._setExpressive(true);
    const stream = adapter.stream();
    adapter._setExpressive(false); // a second turn, before this one's run() runs

    try {
      expect(stream.expressive).toBe(true);
      expect(wrapped.expressive).toBe(false);
    } finally {
      stream.close();
      await adapter.close();
    }
  });
});

describe('StreamAdapter tokenizer while lowering', () => {
  it('tokenizes xml-aware while lowering', async () => {
    // a marker split across two tokens would be lowered as two halves. Labels are
    // free-form English and may contain a period, which an unguarded sentence tokenizer
    // treats as a boundary. The framework passes an xml-aware tokenizer when it builds the
    // adapter; a caller using the default has to get one too.
    const marked = '<expr type="expression" label="Calm. Steady"/> All set.';
    const tokens = async (tokenizer: SentenceTokenizer): Promise<string[]> => {
      const stream = tokenizer.stream();
      stream.pushText(marked);
      stream.endInput();
      const out: string[] = [];
      for await (const ev of stream) out.push(ev.token);
      stream.close();
      return out;
    };

    const adapter = new StreamAdapter(new DeclaringTTS(false));
    try {
      expect(await tokens(adapter._tokenizerFor({ lowering: true }))).toEqual([marked]);
      // the default splits it mid-tag, which is why lowering needs its own
      expect(await tokens(adapter._tokenizerFor({ lowering: false }))).not.toEqual([marked]);
      // one tokenizer, reused across syntheses
      expect(adapter._tokenizerFor({ lowering: true })).toBe(
        adapter._tokenizerFor({ lowering: true }),
      );

      const mine = new BasicSentenceTokenizer();
      const explicit = new StreamAdapter(new DeclaringTTS(false), mine);
      expect(explicit._tokenizerFor({ lowering: true })).toBe(mine); // never second-guessed
      await explicit.close();
    } finally {
      await adapter.close();
    }
  });
});
