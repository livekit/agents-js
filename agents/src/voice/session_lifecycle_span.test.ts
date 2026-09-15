// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Session-level startup and shutdown telemetry through a full fake session: `session_start`
 * grouping the startup work, `session_close` grouping teardown, the state-change events on
 * `agent_session`, and the SIP join keys copied from a linked participant.
 */
import { AudioFrame, ParticipantKind, type RemoteParticipant } from '@livekit/rtc-node';
import { context as otelContext, trace } from '@opentelemetry/api';
import { hrTimeToMilliseconds } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { setTracerProvider, traceTypes, tracer } from '../telemetry/index.js';
import { assertTraceWellFormed } from '../telemetry/testing/trace_schema.js';
import { delay } from '../utils.js';
import { VAD, type VADEvent, VADEventType, VADStream } from '../vad.js';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AgentSessionEventTypes } from './events.js';
import { AudioInput, AudioOutput } from './io.js';
import { FakeLLM } from './testing/fake_llm.js';

initializeLogger({ pretty: false, level: 'silent' });

const endMs = (span: ReadableSpan) => hrTimeToMilliseconds(span.endTime);
// the SDK anchors each span's clock at its start, so end times of different spans can disagree
// by a fraction of a millisecond; the same slack the trace-shape checker allows
const CLOCK_SLACK_MS = 2;

function spansNamed(exporter: InMemorySpanExporter, name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

function only(exporter: InMemorySpanExporter, name: string): ReadableSpan {
  const found = spansNamed(exporter, name);
  expect(found, `expected exactly one ${name} span, got ${found.length}`).toHaveLength(1);
  return found[0]!;
}

function vadEvent(type: VADEventType.START_OF_SPEECH | VADEventType.END_OF_SPEECH): VADEvent {
  return {
    type,
    samplesIndex: 0,
    timestamp: Date.now(),
    speechDuration: 0,
    silenceDuration: 0,
    frames: [],
    probability: 1,
    inferenceDuration: 0,
    speaking: type === VADEventType.START_OF_SPEECH,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: 0,
  };
}

class ScriptedVADStream extends VADStream {
  constructor(vad: VAD) {
    super(vad);
    void this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      while (!this.closed) {
        const { done } = await this.inputReader.read();
        if (done) break;
      }
    } catch {
      /* stream detached/closed */
    }
  }

  emitEvent(ev: VADEvent): void {
    this.sendVADEvent(ev);
  }
}

class ScriptedVAD extends VAD {
  label = 'scripted-vad';
  readonly streams: ScriptedVADStream[] = [];

  constructor() {
    super({ updateInterval: 32 });
  }

  stream(): ScriptedVADStream {
    const stream = new ScriptedVADStream(this);
    this.streams.push(stream);
    return stream;
  }

  startOfSpeech(): void {
    this.streams.at(-1)!.emitEvent(vadEvent(VADEventType.START_OF_SPEECH));
  }

  endOfSpeech(): void {
    this.streams.at(-1)!.emitEvent(vadEvent(VADEventType.END_OF_SPEECH));
  }
}

class ScriptedAudioInput extends AudioInput {
  #controller!: ReadableStreamDefaultController<AudioFrame>;

  constructor() {
    super();
    this.multiStream.addInputStream(
      new ReadableStream<AudioFrame>({
        start: (controller) => {
          this.#controller = controller;
        },
      }),
    );
  }

  push(durationMs: number, sampleRate = 16_000): void {
    const samples = Math.floor((sampleRate * durationMs) / 1000);
    this.#controller.enqueue(new AudioFrame(new Int16Array(samples), sampleRate, 1, samples));
  }
}

/** Plays every frame instantly, so the reply's playout completes. */
class ImmediateOutput extends AudioOutput {
  constructor() {
    super(24_000);
  }

  override async captureFrame(frame: AudioFrame): Promise<void> {
    const segmentCount = this.capturedPlayoutSegments;
    await super.captureFrame(frame);
    if (this.capturedPlayoutSegments > segmentCount) {
      this.onPlaybackStarted(Date.now());
    }
  }

  override flush(): void {
    super.flush();
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0.02, interrupted: false });
    }
  }

  override clearBuffer(): void {
    if (this.pendingPlayoutSegments > 0) {
      this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
    }
  }
}

class TestAgent extends Agent {
  constructor() {
    super({ instructions: 'test' });
  }

  override async ttsNode(): Promise<ReadableStream<AudioFrame>> {
    return new ReadableStream<AudioFrame>({
      start(controller) {
        controller.enqueue(new AudioFrame(new Int16Array(480), 24_000, 1, 480));
        controller.close();
      },
    });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

describe.sequential('session lifecycle spans', () => {
  const TRANSCRIPT = 'Hello there';
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
    otelContext.disable();
  });

  /** One user turn end to end, then the session closes. */
  async function runSession(afterStart?: (session: AgentSession) => void) {
    const vad = new ScriptedVAD();
    const stt = new FakeSTT({
      capabilities: { streaming: true, interimResults: true },
      fakeUserSpeeches: [{ startTime: 0, endTime: 200, transcript: TRANSCRIPT, sttDelay: 100 }],
    });
    const llm = new FakeLLM([{ input: TRANSCRIPT, content: 'Hi!' }]);
    const session = new AgentSession({
      vad,
      stt,
      llm,
      turnHandling: { turnDetection: 'vad', endpointing: { minDelay: 100, maxDelay: 100 } },
    });
    const audioInput = new ScriptedAudioInput();
    session.input.audio = audioInput;
    session.output.audio = new ImmediateOutput();
    await session.start({ agent: new TestAgent() });
    try {
      afterStart?.(session);
      audioInput.push(20);
      await delay(20);
      vad.startOfSpeech();
      await delay(200);
      vad.endOfSpeech();
      await waitFor(
        () =>
          spansNamed(exporter, 'agent_turn').some(
            (span) => traceTypes.ATTR_E2E_LATENCY in span.attributes,
          ),
        10_000,
        'the reply to play',
      );
    } finally {
      await session.close();
    }
    return session;
  }

  it('groups startup under session_start and teardown under session_close', async () => {
    const session = await runSession((session) => {
      // a close handler's work (a transcript upload, say) belongs to the close
      session.on(AgentSessionEventTypes.Close, () => {
        tracer.startSpan({ name: 'rpc_call' }).end();
      });
    });

    const root = only(exporter, 'agent_session');
    const start = only(exporter, 'session_start');
    expect(start.parentSpanContext?.spanId).toBe(root.spanContext().spanId);

    // startup work nests under session_start
    const activityStart = only(exporter, 'start_agent_activity');
    expect(activityStart.parentSpanContext?.spanId).toBe(start.spanContext().spanId);
    const toolsets = only(exporter, 'setup_toolsets');
    expect(toolsets.parentSpanContext?.spanId).toBe(activityStart.spanContext().spanId);
    expect(endMs(start)).toBeGreaterThanOrEqual(endMs(activityStart) - CLOCK_SLACK_MS);

    // the long-lived pipeline is not re-parented: turns stay directly under agent_session
    for (const name of ['user_turn', 'agent_turn']) {
      const turns = spansNamed(exporter, name);
      expect(turns.length, name).toBeGreaterThan(0);
      for (const turn of turns) {
        expect(turn.parentSpanContext?.spanId, name).toBe(root.spanContext().spanId);
      }
    }

    // teardown as one bar with the reason, drain and on_exit nested inside it
    const close = only(exporter, 'session_close');
    expect(close.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(close.attributes[traceTypes.ATTR_CLOSE_REASON]).toBe('user_initiated');
    expect(close.attributes[traceTypes.ATTR_CLOSE_DRAIN]).toBe(false);
    const drains = spansNamed(exporter, 'drain_agent_activity');
    expect(drains.some((d) => d.parentSpanContext?.spanId === close.spanContext().spanId)).toBe(
      true,
    );
    const drain = drains.find((d) => d.parentSpanContext?.spanId === close.spanContext().spanId)!;
    const onExit = only(exporter, 'on_exit');
    expect(onExit.parentSpanContext?.spanId).toBe(drain.spanContext().spanId);
    // the close covers the close event and room io too, and the session ends after all of it:
    // nothing emitted while closing lands under an already ended span
    const handlerWork = only(exporter, 'rpc_call');
    expect(handlerWork.parentSpanContext?.spanId).toBe(close.spanContext().spanId);
    expect(endMs(close)).toBeGreaterThanOrEqual(endMs(handlerWork) - CLOCK_SLACK_MS);
    expect(endMs(root)).toBeGreaterThanOrEqual(endMs(close) - CLOCK_SLACK_MS);
    expect(session.rootSpanContext).toBeUndefined();

    // state timeline on the root span
    const transitions = root.events
      .filter((event) => event.name === 'agent_state_changed')
      .map((event) => [
        event.attributes?.[traceTypes.ATTR_OLD_STATE],
        event.attributes?.[traceTypes.ATTR_NEW_STATE],
      ]);
    expect(transitions).toContainEqual(['initializing', 'listening']);
    expect(transitions.some(([, next]) => next === 'speaking')).toBe(true);
    const userStates = root.events.filter((event) => event.name === 'user_state_changed');
    expect(userStates.some((e) => e.attributes?.[traceTypes.ATTR_NEW_STATE] === 'speaking')).toBe(
      true,
    );
    // the whole tree, not just the edges this test names (telemetry/testing/trace_schema)
    assertTraceWellFormed(exporter.getFinishedSpans());
  });

  it("copies a linked SIP participant's attributes with only the number tagged as PII", async () => {
    const sip = {
      sid: 'PA_sip',
      identity: 'sip_+15550001111',
      kind: ParticipantKind.SIP,
      info: { kind: ParticipantKind.SIP },
      attributes: {
        'sip.callID': 'SCL_abc',
        'sip.trunkID': 'ST_xyz',
        'sip.trunkPhoneNumber': '+15550009999',
        'sip.phoneNumber': '+15550001111',
        'sip.h.x-custom': 'route-7',
        unrelated: 'ignored',
      },
    } as unknown as RemoteParticipant;

    await runSession((session) => session._onRoomIOParticipantLinked(sip));

    const root = only(exporter, 'agent_session');
    const attrs = root.attributes;
    // the customer's own identifiers stay plain
    expect(attrs['lk.sip.callID']).toBe('SCL_abc');
    expect(attrs['lk.sip.trunkID']).toBe('ST_xyz');
    expect(attrs['lk.sip.trunkPhoneNumber']).toBe('+15550009999');
    expect(attrs['lk.sip.h.x-custom']).toBe('route-7');
    // the end user's number is the one PII value
    expect(attrs[traceTypes.ATTR_SIP_PHONE_NUMBER]).toBe('+15550001111');
    expect(attrs['lk.sip.phoneNumber']).toBeUndefined();
    expect(attrs['lk.sip.unrelated']).toBeUndefined();
    const linked = root.events.filter((event) => event.name === 'participant_linked');
    expect(linked).toHaveLength(1);
    expect(linked[0]!.attributes?.[traceTypes.ATTR_PARTICIPANT_KIND]).toBe('SIP');
    // the whole tree, not just the edges this test names (telemetry/testing/trace_schema)
    assertTraceWellFormed(exporter.getFinishedSpans());
  });
});
