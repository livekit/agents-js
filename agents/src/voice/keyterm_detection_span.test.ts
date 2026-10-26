// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The keyterm-detection LLM call is STT context for later turns, not part of any reply: it gets
 * its own `keyterm_detection` span, under the `agent_turn` whose reply fired the conversation
 * event, else under `agent_session`.
 */
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatContext, FunctionCall } from '../llm/chat_context.js';
import { LLM, type LLMStream } from '../llm/llm.js';
import { initializeLogger } from '../log.js';
import type { SpeechEvent, SpeechStream } from '../stt/stt.js';
import { STT } from '../stt/stt.js';
import { setTracerProvider, traceTypes, tracer } from '../telemetry/index.js';
import type { AudioBuffer } from '../utils.js';
import { createConversationItemAddedEvent } from './events.js';
import { KeytermDetector } from './keyterm_detection.js';

initializeLogger({ pretty: false, level: 'silent' });

class FakeStream {
  constructor(
    private pending: string[],
    private confirm: string[],
    private remove: string[],
  ) {}

  async collect() {
    const args = JSON.stringify({
      pending: this.pending,
      confirm: this.confirm,
      remove: this.remove,
    });
    return {
      text: '',
      toolCalls: [new FunctionCall({ callId: '1', name: 'record_keyterms', args })],
      usage: undefined,
      extra: {},
    };
  }

  close(): void {}
}

/** Confirms `Acme` and `LiveKit` on every pass. */
class RecordingLLM extends LLM {
  label(): string {
    return 'recording-llm';
  }

  override get model(): string {
    return 'recording-model';
  }

  override get provider(): string {
    return 'openai';
  }

  chat(): LLMStream {
    return new FakeStream([], ['Acme', 'LiveKit'], []) as unknown as LLMStream;
  }
}

class KeytermSTT extends STT {
  label = 'keyterm.STT';

  constructor() {
    super({ streaming: true, interimResults: false, keyterms: true });
  }

  protected _recognize(_: AudioBuffer): Promise<SpeechEvent> {
    throw new Error('not implemented');
  }

  stream(): SpeechStream {
    throw new Error('not implemented');
  }

  override _updateSessionKeyterms(): void {}
}

class FakeSession extends EventEmitter {
  history = ChatContext.empty();
  rootSpanContext = trace.setSpan(ROOT_CONTEXT, tracer.startSpan({ name: 'agent_session' }));

  addUser(text: string): void {
    const msg = this.history.addMessage({ role: 'user', content: text });
    this.emit('conversation_item_added', createConversationItemAddedEvent(msg));
  }
}

describe.sequential('keyterm_detection span', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let originalProvider: ReturnType<typeof tracer.getProvider>;

  beforeEach(() => {
    originalProvider = tracer.getProvider();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
    setTracerProvider(provider);
  });

  afterEach(async () => {
    setTracerProvider(originalProvider);
    await provider.shutdown();
    trace.disable();
  });

  function detector(): { detector: KeytermDetector; session: FakeSession; llm: RecordingLLM } {
    const llm = new RecordingLLM();
    const d = new KeytermDetector({
      staticKeyterms: ['Zed'],
      options: { enabled: true, llm, turnInterval: 1 },
    });
    const session = new FakeSession();
    d.start(session, new KeytermSTT());
    return { detector: d, session, llm };
  }

  function keytermSpan() {
    const spans = exporter.getFinishedSpans().filter((span) => span.name === 'keyterm_detection');
    expect(spans).toHaveLength(1);
    return spans[0]!;
  }

  it('nests under the agent_turn whose reply added the user message', async () => {
    const { detector: d, session, llm } = detector();
    // the conversation event fires from the reply that answers the user message: the pass is
    // that agent's work on the turn
    const turn = await tracer.startActiveSpan(
      async (turn) => {
        session.addUser('order for Acme');
        expect(d._detectTask).toBeDefined();
        await d._detectTask!.result;
        return turn;
      },
      { name: 'agent_turn' },
    );

    const span = keytermSpan();
    expect(span.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(span.attributes[traceTypes.ATTR_KEYTERMS_COUNT]).toBe(3); // Zed + Acme + LiveKit
    expect(span.attributes[traceTypes.ATTR_KEYTERMS_ADDED]).toBe(2);
    expect(span.attributes[traceTypes.ATTR_KEYTERMS_REMOVED]).toBe(0);
    expect(span.attributes[traceTypes.ATTR_GEN_AI_REQUEST_MODEL]).toBe(llm.model);
    expect(span.attributes[traceTypes.ATTR_GEN_AI_PROVIDER_NAME]).toBe('openai');
    expect(d.keyterms).toEqual(['Zed', 'Acme', 'LiveKit']);
    // the terms themselves stay out of the trace
    expect(JSON.stringify(span.attributes)).not.toContain('Acme');
  });

  it('falls back to the session root without a reply', async () => {
    const { detector: d, session } = detector();
    // no span current: user code edited the history, or the reply was skipped
    session.addUser('order for Acme');
    await d._detectTask!.result;

    const span = keytermSpan();
    const root = trace.getSpan(session.rootSpanContext)!;
    expect(span.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  });
});
