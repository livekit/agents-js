// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { STT, type SpeechEvent, SpeechStream, _FLUSH_MARKER } from '../stt/stt.js';
import type { APIConnectOptions } from '../types.js';
import { Agent, type ModelSettings } from './agent.js';
import { AgentSession } from './agent_session.js';
import type { AudioRecognition, STTPipeline } from './audio_recognition.js';

initializeLogger({ pretty: false, level: 'silent' });

type Input = AudioFrame | 'flush';

class RecordingStream extends SpeechStream {
  label = 'recording-stream';
  inputs: Input[] = [];

  protected async run(): Promise<void> {
    for await (const data of this.input) {
      this.inputs.push(data === RecordingStream.FLUSH_SENTINEL ? 'flush' : data);
    }
  }
}

class RecordingSTT extends STT {
  label = 'recording-stt';
  streams: RecordingStream[] = [];

  constructor(manualFlush: boolean) {
    super({ streaming: true, interimResults: false, manualFlush });
  }

  protected async _recognize(): Promise<SpeechEvent> {
    throw new Error('Use stream()');
  }

  stream(options?: { connOptions?: APIConnectOptions }): RecordingStream {
    const stream = new RecordingStream(this, undefined, options?.connOptions);
    this.streams.push(stream);
    return stream;
  }
}

/** Wraps the audio before handing it to the default node, like a custom pre-processing node. */
class PassthroughAgent extends Agent {
  override async sttNode(
    audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
    modelSettings: ModelSettings,
  ) {
    async function* frames() {
      for await (const frame of audio) {
        expect(frame).toBeInstanceOf(AudioFrame);
        yield frame;
      }
    }
    return Agent.default.sttNode(this, frames(), modelSettings);
  }
}

function makeFrame(): AudioFrame {
  return new AudioFrame(new Int16Array(160), 16000, 1, 160);
}

async function startSession(stt: RecordingSTT, agent: Agent) {
  const session = new AgentSession({
    stt,
    vad: null,
    turnHandling: { turnDetection: 'manual', interruption: { enabled: false } },
  });
  await session.start({
    agent,
    inputOptions: { audioEnabled: false, textEnabled: false },
    outputOptions: { audioEnabled: false, transcriptionEnabled: false },
  });
  await vi.waitFor(() => expect(stt.streams).toHaveLength(1));
  const recognition = (session._activity as unknown as { audioRecognition: AudioRecognition })
    .audioRecognition;
  const pipeline = (recognition as unknown as { sttPipeline: STTPipeline }).sttPipeline;
  return { session, recognition, pipeline, stream: stt.streams[0]! };
}

afterEach(() => vi.restoreAllMocks());

describe('AgentSession manual STT flush', () => {
  it.each([
    ['default', true],
    ['default', false],
    ['passthrough', true],
    ['passthrough', false],
  ] as const)('flushes in audio order (%s node, manualFlush=%s)', async (node, manualFlush) => {
    const stt = new RecordingSTT(manualFlush);
    const agent =
      node === 'default'
        ? new Agent({ instructions: 'test' })
        : new PassthroughAgent({ instructions: 'test' });
    const { session, pipeline, stream } = await startSession(stt, agent);
    try {
      const first = makeFrame();
      const second = makeFrame();
      // queued back to back, so the audio is still buffered on its way when the flush arrives
      const writes = [pipeline.audioChannel.write(first)];
      expect(pipeline.flush()).toBe(manualFlush);
      writes.push(pipeline.audioChannel.write(second));
      await Promise.all(writes);

      const expected = manualFlush ? [first, 'flush', second] : [first, second];
      if (node === 'default') {
        // the flush travels with the audio, so it lands between the two frames
        await vi.waitFor(() => expect(stream.inputs).toEqual(expected));
        expect(stream.inputs[0]).toBe(first);
        expect(stream.inputs.at(-1)).toBe(second);
      } else {
        // a custom node can read ahead, so the flush is delivered but not ordered
        await vi.waitFor(() => expect(stream.inputs).toHaveLength(expected.length));
        expect(stream.inputs).toEqual(expect.arrayContaining(expected));
      }
    } finally {
      await session.close();
    }
  });

  it.each([true, false])(
    'manual commit flushes a supporting STT (manualFlush=%s)',
    async (manualFlush) => {
      const stt = new RecordingSTT(manualFlush);
      const { session, recognition, pipeline, stream } = await startSession(
        stt,
        new Agent({ instructions: 'test' }),
      );
      try {
        const frame = makeFrame();
        await pipeline.audioChannel.write(frame);
        await vi.waitFor(() => expect(stream.inputs).toEqual([frame]));

        recognition.commitUserTurn(false);
        if (manualFlush) {
          await vi.waitFor(() => expect(stream.inputs).toEqual([frame, 'flush']));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(stream.inputs).toEqual([frame]);
        }
      } finally {
        await session.close();
      }
    },
  );
});

describe('SpeechStream flush marker', () => {
  it('flushes at the marker position in its input audio', async () => {
    const stt = new RecordingSTT(true);
    const stream = stt.stream();
    const [first, second] = [makeFrame(), makeFrame()];
    stream.updateInputStream(
      new ReadableStream<AudioFrame>({
        start(controller) {
          controller.enqueue(first);
          controller.enqueue(_FLUSH_MARKER as unknown as AudioFrame);
          controller.enqueue(second);
        },
      }),
    );
    try {
      await vi.waitFor(() => expect(stream.inputs).toEqual([first, 'flush', second]));
    } finally {
      stream.close();
    }
  });
});
