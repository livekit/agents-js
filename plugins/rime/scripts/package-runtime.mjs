// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// Copied into an isolated npm installation by test-package.mjs.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Duplex } from 'node:stream';

const require = createRequire(import.meta.url);
const cjs = process.argv[2] === 'cjs';
const hasSDK = process.argv[3] === 'sdk';
const agents = cjs ? require('@livekit/agents') : await import('@livekit/agents');
const rime = cjs
  ? require('@livekit/agents-plugin-rime')
  : await import('@livekit/agents-plugin-rime');
const { AudioFrame } = cjs ? require('@livekit/rtc-node') : await import('@livekit/rtc-node');
agents.initializeLogger({ pretty: false, level: 'silent' });
const tts = new rime.TTS({ apiKey: 'test-key' });
await tts.close();
const audio = new AudioFrame(new Int16Array(1600), 16000, 1, 1600);
if (!hasSDK) {
  assert.throws(() => require.resolve('@rimelabs/sdk'));
  const stt = new rime.STT({ apiKey: 'test-key' });
  await assert.rejects(stt.recognize(audio), /Install @rimelabs\/sdk/);
  await stt.close();
  const version = Object.getOwnPropertyDescriptor(process.versions, 'node');
  try {
    Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
    assert.throws(() => new rime.STT({ apiKey: 'test-key' }), /Node.js 22/);
    const ttsOnOlderNode = new rime.TTS({ apiKey: 'test-key' });
    await ttsOnOlderNode.close();
  } finally {
    Object.defineProperty(process.versions, 'node', version);
  }
  console.log(
    `${process.argv[2]}: TTS imports without SDK, missing-SDK and unsupported-Node errors passed`,
  );
  process.exit(0);
}

// Exercise the real published SDK, mocking only its external transport factory.
const sdkEntry = import.meta.resolve('@rimelabs/sdk');
const { transport } = await import(new URL('./stt/transport.js', sdkEntry));
const original = transport.makeClient;
const { StreamingOutputContract } = createRequire(sdkEntry)('@rimelabs/api');
const calls = [];
let hanging = false;
let ready = () => {};
let cancelled = 0;
const headers = { get: () => ['packed-request'] };
transport.makeClient = () => ({
  waitForReady(_deadline, callback) {
    queueMicrotask(() => callback(null));
  },
  close() {},
  makeUnaryRequest(_path, _serialize, _deserialize, request, _metadata, callback) {
    calls.push(request);
    const call = new EventEmitter();
    call.cancel = () => {
      cancelled++;
    };
    queueMicrotask(() => {
      call.emit('metadata', headers);
      ready();
      if (hanging) return;
      callback(null, { text: 'packed unary', language: { tag: 'en', source: 1 } });
    });
    return call;
  },
  makeBidiStreamRequest() {
    let contract;
    let revision = 0n;
    let text = '';
    const call = new Duplex({
      objectMode: true,
      read() {},
      write(message, _encoding, callback) {
        calls.push(message);
        if (message.payload.case === 'config') {
          contract = message.payload.value.outputContract;
          call.emit('metadata', headers);
          call.push({
            payload: {
              case: 'accepted',
              value: { outputContract: contract, language: { tag: 'en', source: 1 } },
            },
          });
        } else {
          // Values come from the published schema; no plugin wire implementation is used.
          const append = contract === StreamingOutputContract.APPEND_FRAGMENTS;
          text = append ? text + ' hi\n' : 'packed streaming';
          revision += append ? 0n : 1n;
          call.push({
            payload: append
              ? { case: 'delta', value: { text: ' hi\n' } }
              : { case: 'hypothesis', value: { text, revision } },
          });
        }
        callback();
      },
      final(callback) {
        call.push({
          payload: { case: 'done', value: { text, revision, language: { tag: 'en', source: 1 } } },
        });
        call.push(null);
        queueMicrotask(() => call.emit('status', { code: 0, metadata: headers }));
        callback();
      },
    });
    call.cancel = () => {
      if (!call.destroyed) call.destroy();
    };
    return call;
  },
});
class Detector extends agents.VAD {
  label = 'packed.VAD';
  constructor() {
    super({ updateInterval: 32 });
  }
  stream() {
    return (this.current = new DetectorStream(this));
  }
}
class DetectorStream extends agents.VADStream {
  constructor(owner) {
    super(owner);
    this.task = (async () => {
      try {
        while (!(await this.inputReader.read()).done) {}
      } finally {
        this.close();
      }
    })();
  }
  send(type) {
    return this.outputWriter.write({
      type,
      frames: [audio],
      timestamp: Date.now(),
      speechDuration: 0,
      silenceDuration: 0,
      inferenceDuration: 0,
      samplesIndex: 0,
      probability: 1,
      speaking: true,
      rawAccumulatedSilence: 0,
      rawAccumulatedSpeech: 0,
    });
  }
}
try {
  const stt = new rime.STT({ apiKey: 'test-key', connOptions: { maxRetry: 0, timeoutMs: 2000 } });
  try {
    const result = await stt.recognize(audio);
    assert.equal(result.alternatives[0].text, 'packed unary');
    assert.equal(result.requestId, 'packed-request');
    assert.equal(Buffer.from(calls[0].audio).toString('ascii', 0, 4), 'RIFF');
  } finally {
    await stt.close();
  }
  for (const contract of ['revised_hypotheses', 'append_fragments']) {
    const detector = new Detector();
    const stt = new rime.STT({
      apiKey: 'test-key',
      vad: detector,
      outputContract: contract,
      connOptions: { timeoutMs: 2000 },
    });
    stt.on('error', () => {});
    try {
      const stream = stt.stream();
      const events = [];
      const reader = (async () => {
        for await (const event of stream) events.push(event);
      })();
      while (!detector.current) await new Promise((resolve) => setImmediate(resolve));
      await detector.current.send(agents.VADEventType.START_OF_SPEECH);
      await detector.current.send(agents.VADEventType.END_OF_SPEECH);
      stream.endInput();
      await reader;
      assert.equal(stream.terminalError, undefined);
      assert.deepEqual(
        events.map((event) => event.type),
        [0, 1, 2, 4, 3],
      );
      assert.equal(
        events[2].alternatives[0].text,
        contract === 'append_fragments' ? ' hi\n' : 'packed streaming',
      );
      assert.equal(events[2].requestId, 'packed-request');
      await stream.close();
    } finally {
      await stt.close();
    }
  }
  hanging = true;
  for (const action of ['timeout', 'abort', 'close']) {
    const started = new Promise((resolve) => {
      ready = resolve;
    });
    const stt = new rime.STT({
      apiKey: 'test-key',
      connOptions: { timeoutMs: action === 'timeout' ? 30 : 2000, maxRetry: 0 },
    });
    const controller = new AbortController();
    const request = stt.recognize(audio, controller.signal);
    const assertion = assert.rejects(request, (error) => {
      assert.equal(error.retryable, action === 'timeout');
      assert.deepEqual(error.body, { request_id: 'packed-request' });
      assert.equal(error.cause, undefined);
      return true;
    });
    await started;
    if (action === 'abort') controller.abort(new Error('private cause'));
    if (action === 'close') await stt.close();
    await assertion;
    await stt.close();
  }
  assert.ok(cancelled >= 3);
  console.log(
    `${process.argv[2]}: actual SDK unary, both streaming contracts, timeout/abort/close passed`,
  );
} finally {
  transport.makeClient = original;
}
