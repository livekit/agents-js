// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { beforeAll, describe, expect, it } from 'vitest';
import { ChatContext, ChatMessage, FunctionCall } from '../llm/chat_context.js';
import { LLM, type LLMStream } from '../llm/llm.js';
import { initializeLogger } from '../log.js';
import type { LLMMetrics } from '../metrics/base.js';
import type { SpeechEvent, SpeechStream } from '../stt/stt.js';
import { STT } from '../stt/stt.js';
import type { AudioBuffer } from '../utils.js';
import { Future } from '../utils.js';
import { createConversationItemAddedEvent } from './events.js';
import type { ConversationItemAddedEvent } from './events.js';
import {
  type KeytermDetectionOptions,
  KeytermDetector,
  PENDING_TTL,
  detectKeyterms,
  formatInput,
  parseToolCall,
  resolveDetection,
} from './keyterm_detection.js';

type DetectionResult = [string[], string[], string[]];

const detector = (opts?: {
  staticKeyterms?: string[];
  options?: KeytermDetectionOptions;
}): KeytermDetector => new KeytermDetector(opts);

/** Detected terms with their confirmed flag (confirmed first, then pending). */
const entries = (d: KeytermDetector): [string, boolean][] => [
  ...d._detectedTerms.map((t): [string, boolean] => [t, true]),
  ...[...d._pendingTerms.keys()].map((t): [string, boolean] => [t, false]),
];

const ctx = (text: string = 'hello'): ChatContext => {
  const c = ChatContext.empty();
  c.addMessage({ role: 'user', content: text });
  return c;
};

/** STT that records every _updateSessionKeyterms() / _pushConversationItem() call. */
class RecordingSTT extends STT {
  label = 'recording.STT';
  pushed: string[][] = [];
  chatItems: ChatMessage[] = [];

  constructor(opts?: { supportsKeyterms?: boolean; supportsChatContext?: boolean }) {
    super({
      streaming: true,
      interimResults: false,
      keyterms: opts?.supportsKeyterms ?? true,
      chatContext: opts?.supportsChatContext ?? false,
    });
  }

  protected _recognize(_: AudioBuffer): Promise<SpeechEvent> {
    throw new Error('not implemented');
  }

  stream(): SpeechStream {
    throw new Error('not implemented');
  }

  override _updateSessionKeyterms(keyterms: string[]): void {
    this.pushed.push([...keyterms]);
  }

  override _pushConversationItem(ev: ConversationItemAddedEvent): void {
    if (ev.item instanceof ChatMessage) {
      this.chatItems.push(ev.item);
    }
  }
}

class FakeStream {
  private args: string;

  constructor(pending: string[], confirm: string[], remove: string[]) {
    this.args = JSON.stringify({ pending, confirm, remove });
  }

  async collect() {
    const call = new FunctionCall({ callId: '1', name: 'record_keyterms', args: this.args });
    return { text: '', toolCalls: [call], usage: undefined, extra: {} };
  }

  close(): void {}
}

/**
 * Fake LLM: returns a `record_keyterms` call per `chat()`, one result tuple per call.
 *
 * Subclasses LLM so the detector's `instanceof LLM` gate passes; the last result
 * repeats once the sequence is exhausted.
 */
class RecordingLLM extends LLM {
  private results: DetectionResult[];
  calls = 0;
  lastChatCtx: ChatContext | undefined;

  constructor(...results: DetectionResult[]) {
    super();
    this.results = results.length > 0 ? results : [[[], [], []]];
  }

  label(): string {
    return 'recording-llm';
  }

  chat({ chatCtx }: { chatCtx: ChatContext }): LLMStream {
    const result = this.results[Math.min(this.calls, this.results.length - 1)]!;
    this.calls += 1;
    this.lastChatCtx = chatCtx;
    return new FakeStream(...result) as unknown as LLMStream;
  }
}

class BlockingStream extends FakeStream {
  constructor(
    private gate: Future,
    result: DetectionResult = [[], [], []],
  ) {
    super(...result);
  }

  override async collect() {
    await this.gate.await;
    return super.collect();
  }

  // mirror the real LLMStream: close() ends the output queue, unblocking collect()
  override close(): void {
    if (!this.gate.done) {
      this.gate.resolve();
    }
  }
}

/** Fake LLM whose response blocks until `gate` is resolved (for single-flight tests). */
class BlockingLLM extends LLM {
  gate = new Future();
  calls = 0;

  constructor(private result: DetectionResult = [[], [], []]) {
    super();
  }

  label(): string {
    return 'blocking-llm';
  }

  chat(_: { chatCtx: ChatContext }): LLMStream {
    this.calls += 1;
    return new BlockingStream(this.gate, this.result) as unknown as LLMStream;
  }
}

class FakeSession extends EventEmitter {
  history = ChatContext.empty();

  addUser(text: string): void {
    const msg = this.history.addMessage({ role: 'user', content: text });
    this.emit('conversation_item_added', createConversationItemAddedEvent(msg));
  }

  addAssistant(text: string): void {
    const msg = this.history.addMessage({ role: 'assistant', content: text });
    this.emit('conversation_item_added', createConversationItemAddedEvent(msg));
  }
}

const drain = async (d: KeytermDetector): Promise<void> => {
  await Promise.resolve();
  if (d._detectTask !== undefined) {
    // a failed pass is logged + re-raised on the task
    await d._detectTask.result.catch(() => {});
  }
};

beforeAll(() => {
  initializeLogger({ pretty: false });
});

// -- keyterm state machine (driven through one detection pass each) --

describe('keyterm state machine', () => {
  it('only confirmed terms are applied', async () => {
    const d = detector({
      staticKeyterms: ['Acme'],
      options: { llm: new RecordingLLM([['Niamh'], ['Foo'], []]) },
    });
    await d.runOnce(ctx());
    // pending terms are tracked but not applied (entries: confirmed then pending)
    expect(entries(d)).toEqual([
      ['Foo', true],
      ['Niamh', false],
    ]);
    expect(d.keyterms).toEqual(['Acme', 'Foo']);
  });

  it('pending then confirmed', async () => {
    const d = detector({
      options: {
        llm: new RecordingLLM([['Kubernetes'], [], []], [[], ['Kubernetes'], []]),
      },
    });
    await d.runOnce(ctx());
    expect(d.keyterms).toEqual([]);
    await d.runOnce(ctx());
    expect(entries(d)).toEqual([['Kubernetes', true]]);
    expect(d.keyterms).toEqual(['Kubernetes']);
  });

  it('static terms shown to llm as applied', async () => {
    const fake = new RecordingLLM();
    const d = detector({ staticKeyterms: ['Acme Corp'], options: { llm: fake } });
    await d.runOnce(ctx());
    // user terms must appear in the applied list, or the LLM keeps re-proposing them
    expect(fake.lastChatCtx).toBeDefined();
    const items = fake.lastChatCtx!.items;
    const lastItem = items[items.length - 1]!;
    const userMsg = (lastItem instanceof ChatMessage ? lastItem.textContent : undefined) ?? '';
    const appliedSection = userMsg.split('## Applied keyterms')[1]!.split('\n')[1]!;
    expect(appliedSection).toContain('Acme Corp');
  });

  it('user precedence and dedup', async () => {
    const d = detector({
      staticKeyterms: ['Acme', 'Acme', 'LiveKit'],
      options: { llm: new RecordingLLM([[], ['LiveKit', 'Foo'], []]) },
    });
    expect(d.staticKeyterms).toEqual(['Acme', 'LiveKit']);
    await d.runOnce(ctx()); // an auto term equal to a user term is dropped
    expect(entries(d).map(([t]) => t)).toEqual(['Foo']);
    expect(d.keyterms).toEqual(['Acme', 'LiveKit', 'Foo']);
  });

  it('confirmed cannot revert to pending', async () => {
    const d = detector({
      options: { llm: new RecordingLLM([[], ['Niamh'], []], [['Niamh'], [], []]) },
    });
    await d.runOnce(ctx());
    expect(d.keyterms).toEqual(['Niamh']);
    await d.runOnce(ctx()); // a stray `pending` must not reset a confirmed term
    expect(entries(d)).toEqual([['Niamh', true]]);
  });

  it('correction removes and replaces', async () => {
    const d = detector({
      options: {
        llm: new RecordingLLM([['Jon'], [], []], [['John'], [], ['Jon']], [[], ['John'], []]),
      },
    });
    await d.runOnce(ctx());
    expect(entries(d)).toEqual([['Jon', false]]);
    await d.runOnce(ctx()); // misheard spelling removed, corrected one added as pending
    expect(entries(d)).toEqual([['John', false]]);
    await d.runOnce(ctx());
    expect(d.keyterms).toEqual(['John']);
  });

  it('remove applies to confirmed terms', async () => {
    const d = detector({
      options: { llm: new RecordingLLM([[], ['Jon'], []], [[], ['John'], ['Jon']]) },
    });
    await d.runOnce(ctx());
    expect(d.keyterms).toEqual(['Jon']);
    await d.runOnce(ctx()); // a user correction can remove an already-applied term
    expect(d.keyterms).toEqual(['John']);
  });

  it('remove unknown is noop', async () => {
    const d = detector({
      options: { llm: new RecordingLLM([[], ['Foo'], []], [[], [], ['does-not-exist']]) },
    });
    await d.runOnce(ctx());
    await d.runOnce(ctx());
    expect(d.keyterms).toEqual(['Foo']);
  });

  it('cap evicts oldest confirmed', async () => {
    const d = detector({
      options: { maxKeyterms: 3, llm: new RecordingLLM([[], ['a', 'b', 'c', 'd', 'e'], []]) },
    });
    await d.runOnce(ctx());
    expect(entries(d).map(([t]) => t)).toEqual(['c', 'd', 'e']);
  });

  it('pending evicted when not confirmed', async () => {
    // pass 1 adds "Tmp" pending; later passes never confirm it, so it ages out
    const d = detector({
      options: { llm: new RecordingLLM([['Tmp'], [], []], [[], ['Other'], []]) },
    });
    await d.runOnce(ctx());
    for (let i = 0; i < PENDING_TTL - 1; i++) {
      await d.runOnce(ctx());
    }
    expect(entries(d).map(([t]) => t)).toContain('Tmp');
    await d.runOnce(ctx()); // TTL exceeded
    expect(entries(d).map(([t]) => t)).not.toContain('Tmp');
  });

  it('confirmed not evicted by staleness', async () => {
    const d = detector({
      options: { llm: new RecordingLLM([[], ['Keep'], []], [['x'], [], []]) },
    });
    await d.runOnce(ctx());
    for (let i = 0; i < PENDING_TTL + 2; i++) {
      await d.runOnce(ctx()); // pending churn ages out, but the confirmed term stays
    }
    expect(d.keyterms).toEqual(['Keep']);
  });

  it('failed pass keeps state', async () => {
    class BoomLLM extends LLM {
      label(): string {
        return 'boom-llm';
      }

      chat(_: { chatCtx: ChatContext }): LLMStream {
        throw new Error('boom');
      }
    }

    const d = detector({ options: { llm: new BoomLLM() } });
    // a failed pass is logged and re-raised on the (fire-and-forget) task; state is untouched
    await expect(d.runOnce(ctx())).rejects.toThrow('boom');
    expect(d.keyterms).toEqual([]);
  });
});

// -- STT binding --

describe('STT binding', () => {
  it('push only on applied change', async () => {
    const stt = new RecordingSTT();
    const session = new FakeSession();
    const d = detector({
      staticKeyterms: ['Acme'],
      options: {
        enabled: true,
        llm: new RecordingLLM([['Foo'], [], []], [[], ['Foo'], []]),
      },
    });
    d.start(session, stt);
    expect(stt.pushed).toEqual([['Acme']]); // start pushes the current set

    session.addUser('u1');
    await drain(d); // pending Foo: tracked, no applied change -> no push
    expect(stt.pushed).toEqual([['Acme']]);

    session.addUser('u2');
    await drain(d); // confirm Foo: push
    expect(stt.pushed[stt.pushed.length - 1]).toEqual(['Acme', 'Foo']);
    await d.aclose();
  });

  it('detection llm metrics forwarded', async () => {
    // the detector re-emits its detection LLM's usage, so it reaches the session metrics pipeline
    const received: LLMMetrics[] = [];
    const fake = new RecordingLLM();
    const d = detector({ options: { enabled: true, llm: fake } });
    d.on('metrics_collected', (m) => received.push(m));
    d.start(new FakeSession(), new RecordingSTT());

    const metrics: LLMMetrics = {
      type: 'llm_metrics',
      label: fake.label(),
      requestId: 'r1',
      timestamp: 0,
      durationMs: 0,
      ttftMs: 0,
      cancelled: false,
      completionTokens: 1,
      promptTokens: 2,
      promptCachedTokens: 0,
      totalTokens: 3,
      tokensPerSecond: 0,
    };
    fake.emit('metrics_collected', metrics);
    expect(received).toEqual([metrics]);

    await d.aclose(); // detaches from the detection LLM so a later emit is dropped
    fake.emit('metrics_collected', metrics);
    expect(received).toEqual([metrics]);
  });

  it('start same stt does not repush', async () => {
    const stt = new RecordingSTT();
    const session = new FakeSession();
    const d = detector({
      staticKeyterms: ['Acme'],
      options: { enabled: true, llm: new RecordingLLM() },
    });
    d.start(session, stt);
    expect(stt.pushed).toEqual([['Acme']]);
    await d.aclose();
    // re-binding the same instance on the next activity must not re-push (some STTs reconnect)
    d.start(session, stt);
    expect(stt.pushed).toEqual([['Acme']]);
    await d.aclose();
  });

  it('static terms pushed without detection', async () => {
    const stt = new RecordingSTT();
    const session = new FakeSession();
    const d = detector({ staticKeyterms: ['Acme'], options: { enabled: false } });
    d.start(session, stt); // detection off must still bind the STT and push
    expect(stt.pushed).toEqual([['Acme']]);
    d.setStaticKeyterms(['New']);
    expect(stt.pushed[stt.pushed.length - 1]).toEqual(['New']);
    await d.aclose();
  });

  it('start pushes empty list to keyterm-capable stt', async () => {
    const stt = new RecordingSTT();
    const session = new FakeSession();
    // simulate an earlier binding that left session keyterms on the instance
    stt._updateSessionKeyterms(['Stale']);
    const d = detector({ options: { enabled: false } });
    d.start(session, stt); // empty set still pushed, so stale terms are cleared
    expect(stt.pushed).toEqual([['Stale'], []]);
    await d.aclose();
  });

  it('start without terms does not warn unsupported stt', async () => {
    const stt = new RecordingSTT({ supportsKeyterms: false });
    const session = new FakeSession();
    const d = detector({ options: { enabled: false } });
    d.start(session, stt); // nothing to apply + no capability -> no push, no warning
    expect(stt.pushed).toEqual([]);
    await d.aclose();
  });

  it('set static keyterms pushes', async () => {
    const stt = new RecordingSTT();
    const session = new FakeSession();
    const d = detector({ options: { enabled: true, llm: new RecordingLLM() } });
    d.start(session, stt);
    d.setStaticKeyterms(['New']);
    expect(stt.pushed[stt.pushed.length - 1]).toEqual(['New']);
    await d.aclose();
  });

  it('unsupported stt warn and skip', () => {
    const stt = new RecordingSTT({ supportsKeyterms: false });
    // exercise the base method (warn-and-skip), not the recorder override
    STT.prototype._updateSessionKeyterms.call(stt, ['a', 'b']);
    expect(stt.pushed).toEqual([]);
  });
});

// -- chat context sink (native carryover) --
// forwarding (subscribe + push every turn) lives in AgentActivity; here we only cover the
// STT sink contract: a supporting STT receives the pushed turns, an unsupported one warns.

describe('chat context sink', () => {
  it('push conversation item forwards to supporting stt', () => {
    const stt = new RecordingSTT({ supportsChatContext: true });
    const user = createConversationItemAddedEvent(
      new ChatMessage({ role: 'user', content: ['hi'] }),
    );
    const agent = createConversationItemAddedEvent(
      new ChatMessage({ role: 'assistant', content: ['Welcome'] }),
    );
    stt._pushConversationItem(user); // both user and agent turns are forwarded
    stt._pushConversationItem(agent);
    expect(stt.chatItems.map((m) => m.textContent)).toEqual(['hi', 'Welcome']);
  });

  it('unsupported stt chat ctx warn and skip', () => {
    const stt = new RecordingSTT({ supportsChatContext: false });
    const ev = createConversationItemAddedEvent(
      new ChatMessage({ role: 'assistant', content: ['hi'] }),
    );
    // exercise the base method (warn-and-skip), not the recorder override
    STT.prototype._pushConversationItem.call(stt, ev);
    expect(stt.chatItems).toEqual([]);
  });
});

// -- triggering --

describe('triggering', () => {
  it('triggers every n user turns', async () => {
    const session = new FakeSession();
    const fake = new RecordingLLM([[], ['Acme'], []]);
    const d = detector({ options: { enabled: true, turnInterval: 2, llm: fake } });
    d.start(session, new RecordingSTT());

    session.addUser('first'); // below interval
    await drain(d);
    expect(fake.calls).toBe(0);

    session.addAssistant('ack'); // assistant turns don't advance the counter
    await drain(d);
    expect(fake.calls).toBe(0);

    session.addUser('second'); // triggers
    await drain(d);
    expect(fake.calls).toBe(1);

    await d.aclose();
  });

  it('ignores assistant messages for counting', async () => {
    const session = new FakeSession();
    const fake = new RecordingLLM();
    const d = detector({ options: { enabled: true, llm: fake } });
    d.start(session, new RecordingSTT());

    session.addAssistant('hello');
    await drain(d);
    expect(fake.calls).toBe(0);

    session.addUser('hi');
    await drain(d);
    expect(fake.calls).toBe(1);

    await d.aclose();
  });

  it('empty user turn does not trigger', async () => {
    const session = new FakeSession();
    const fake = new RecordingLLM();
    const d = detector({ options: { enabled: true, llm: fake } });
    d.start(session, new RecordingSTT());

    session.addUser('');
    await drain(d);
    expect(fake.calls).toBe(0);

    await d.aclose();
  });

  it('single flight skips overlapping pass', async () => {
    const session = new FakeSession();
    const fake = new BlockingLLM();
    const d = detector({ options: { enabled: true, llm: fake } });
    d.start(session, new RecordingSTT());

    session.addUser('first');
    await Promise.resolve();
    expect(fake.calls).toBe(1);

    session.addUser('second'); // a pass is still in flight -> skipped, not queued
    await Promise.resolve();
    expect(fake.calls).toBe(1);

    fake.gate.resolve();
    await drain(d);
    expect(fake.calls).toBe(1);
    await d.aclose();
  });

  it('aclose cancels an in-flight pass without applying its result', async () => {
    const session = new FakeSession();
    // if the pass were allowed to finish, it would confirm "Acme"
    const fake = new BlockingLLM([[], ['Acme'], []]);
    const stt = new RecordingSTT();
    const d = detector({ options: { enabled: true, llm: fake } });
    d.start(session, stt);
    expect(stt.pushed).toEqual([[]]); // bind-time push of the (empty) current set

    session.addUser('hi');
    await Promise.resolve();
    expect(fake.calls).toBe(1);

    // the gate is never resolved by the test: aclose must unblock the pass itself
    // (via the abort signal) instead of waiting out the detection timeout
    await d.aclose();

    expect(d.keyterms).toEqual([]); // cancelled pass must not touch state
    expect(stt.pushed).toEqual([[]]); // ...nor push to the STT
  });

  it('aclose unsubscribes', async () => {
    const session = new FakeSession();
    const fake = new RecordingLLM();
    const d = detector({ options: { enabled: true, llm: fake } });
    d.start(session, new RecordingSTT());
    await d.aclose();

    session.addUser('hi');
    await Promise.resolve();
    expect(fake.calls).toBe(0);
  });

  it('disabled detection does not trigger', async () => {
    const session = new FakeSession();
    const fake = new RecordingLLM([[], ['Acme'], []]);
    const d = detector({ options: { enabled: false, llm: fake } });
    d.start(session, new RecordingSTT());

    session.addUser('the Acme Grand');
    await drain(d);
    expect(fake.calls).toBe(0);
    expect(d.keyterms).toEqual([]);
  });

  it('unsupported stt skips detection', async () => {
    // no point running LLM detection passes when the STT can't consume the keyterms
    const session = new FakeSession();
    const fake = new RecordingLLM([[], ['Acme'], []]);
    const d = detector({ options: { enabled: true, llm: fake } });
    d.start(session, new RecordingSTT({ supportsKeyterms: false }));

    session.addUser('the Acme Grand');
    await drain(d);
    expect(fake.calls).toBe(0);
  });
});

// -- module helpers --

describe('module helpers', () => {
  it('detect keyterms parses result', async () => {
    const llm = new RecordingLLM([[], ['Niamh'], ['Jon']]);
    const [pending, confirm, remove] = await detectKeyterms(llm, ctx("It's Niamh"), {
      currentKeyterms: [],
    });
    expect(pending).toEqual([]);
    expect(confirm).toEqual(['Niamh']);
    expect(remove).toEqual(['Jon']);
    // no transcript -> no LLM call, empty result
    expect(await detectKeyterms(llm, ChatContext.empty())).toEqual([[], [], []]);
  });

  it('parse tool call', () => {
    const call = new FunctionCall({
      callId: '1',
      name: 'record_keyterms',
      args: JSON.stringify({
        pending: ['John', '  ', 5], // blanks and non-strings are dropped
        confirm: ['Foo'],
        remove: ['Jon'],
      }),
    });
    const [pending, confirm, remove] = parseToolCall([call]);
    expect(pending).toEqual(['John']);
    expect(confirm).toEqual(['Foo']);
    expect(remove).toEqual(['Jon']);
  });

  it('parse tool call missing', () => {
    expect(parseToolCall([])).toEqual([[], [], []]);
    const bad = new FunctionCall({ callId: '1', name: 'record_keyterms', args: 'not json' });
    expect(parseToolCall([bad])).toEqual([[], [], []]);
  });

  it('format input splits applied and candidate', () => {
    const text = formatInput(ctx('hi'), [
      ['Term1', true],
      ['Term2', false],
    ]);
    expect(text).toBeDefined();
    expect(text).toContain('Applied keyterms');
    expect(text).toContain('Term1');
    expect(text).toContain('Candidate keyterms');
    expect(text).toContain('Term2');
    expect(text).toContain('record_keyterms'); // trailing instruction
    // no transcript yet -> nothing to send
    expect(formatInput(ChatContext.empty(), [])).toBeUndefined();
  });

  it('resolve detection', () => {
    expect(resolveDetection(undefined).enabled).toBe(false);
    expect(resolveDetection({ enabled: false }).enabled).toBe(false);

    const resolved = resolveDetection({ enabled: true });
    expect(resolved.enabled).toBe(true);
    expect(resolved.turnInterval).toBe(1);
    expect(resolved.maxKeyterms).toBeUndefined();
  });
});
