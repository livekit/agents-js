// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame, type Room, TrackSource } from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentInput } from '../io.js';
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

function createParticipantInput() {
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

  return { input, participant, source };
}

describe('ParticipantAudioInputStream', () => {
  afterEach(() => {
    audioStreams.length = 0;
    vi.clearAllMocks();
  });

  it('drops frames while detached and resumes forwarding when attached', async () => {
    const { input, participant, source } = createParticipantInput();
    input.setParticipant(participant.identity);
    const agentInput = new AgentInput(() => {});
    agentInput.audio = input;

    const reader = input.stream.getReader();
    const initialFrame = createFrame(1);
    source.controller().enqueue(initialFrame);
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: initialFrame });

    agentInput.setAudioEnabled(false);
    source.controller().enqueue(createFrame(2));
    await nextTick();

    agentInput.setAudioEnabled(true);
    const resumedFrame = createFrame(3);
    source.controller().enqueue(resumedFrame);
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: resumedFrame });

    source.controller().close();
    reader.releaseLock();
    await input.close();
  });

  it('gates a track subscribed after input is disabled', async () => {
    const { input, participant, source } = createParticipantInput();
    const onDetached = vi.spyOn(input, 'onDetached');
    const agentInput = new AgentInput(() => {});
    agentInput.setAudioEnabled(false);
    agentInput.audio = input;

    expect(onDetached).toHaveBeenCalledOnce();

    input.setParticipant(participant.identity);
    const reader = input.stream.getReader();
    source.controller().enqueue(createFrame(1));
    await nextTick();

    agentInput.setAudioEnabled(true);
    const attachedFrame = createFrame(2);
    source.controller().enqueue(attachedFrame);
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: attachedFrame });

    source.controller().close();
    reader.releaseLock();
    await input.close();
  });

  it('keeps mute when onDetached override omits attach-state updates', async () => {
    const { input, participant, source } = createParticipantInput();
    input.setParticipant(participant.identity);
    // Simulate a subclass/wrapper that overrides the hook without updating gate state.
    input.onDetached = () => {};

    const agentInput = new AgentInput(() => {});
    agentInput.audio = input;

    const reader = input.stream.getReader();
    const initialFrame = createFrame(1);
    source.controller().enqueue(initialFrame);
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: initialFrame });

    agentInput.setAudioEnabled(false);
    source.controller().enqueue(createFrame(2));
    await nextTick();

    agentInput.setAudioEnabled(true);
    const resumedFrame = createFrame(3);
    source.controller().enqueue(resumedFrame);
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: resumedFrame });

    source.controller().close();
    reader.releaseLock();
    await input.close();
  });
});
