// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type Room, TrackSource } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParticipantAudioInputStream } from './_input.js';

const audioStreams = vi.hoisted(() => [] as ReadableStream<AudioFrame>[]);

vi.mock('@livekit/rtc-node', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    AudioStream: vi.fn(function MockAudioStream() {
      const stream = audioStreams.shift();
      if (!stream) {
        throw new Error('No mock audio stream configured');
      }
      return stream;
    }),
  };
});

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

function createAudioStream() {
  let controller!: ReadableStreamDefaultController<AudioFrame>;
  const stream = new ReadableStream<AudioFrame>({
    start(streamController) {
      controller = streamController;
    },
  });
  return { stream, controller: () => controller };
}

function createFrame(value: number): AudioFrame {
  return new AudioFrame(new Int16Array([value]), 24000, 1, 1);
}

describe('ParticipantAudioInputStream', () => {
  afterEach(() => {
    audioStreams.length = 0;
    vi.clearAllMocks();
  });

  it('drops frames while detached and resumes forwarding when attached', async () => {
    const source = createAudioStream();
    audioStreams.push(source.stream);

    const publication = {
      sid: 'microphone-track',
      source: TrackSource.SOURCE_MICROPHONE,
      track: {},
    };
    const participant = {
      identity: 'caller',
      trackPublications: new Map([[publication.sid, publication]]),
    };
    const room = {
      remoteParticipants: new Map([[participant.identity, participant]]),
      on: vi.fn(),
      off: vi.fn(),
    };
    const input = new ParticipantAudioInputStream({
      room: room as unknown as Room,
      sampleRate: 24000,
      numChannels: 1,
    });
    input.setParticipant(participant.identity);

    const reader = input.stream.getReader();
    const initialFrame = createFrame(1);
    source.controller().enqueue(initialFrame);
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: initialFrame });

    input.onDetached();
    source.controller().enqueue(createFrame(2));
    await nextTick();

    input.onAttached();
    const resumedFrame = createFrame(3);
    source.controller().enqueue(resumedFrame);
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: resumedFrame });

    source.controller().close();
    reader.releaseLock();
    await input.close();
  });
});
