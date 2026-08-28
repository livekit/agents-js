// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AudioFrame,
  type FrameProcessor,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  RoomEvent,
  TrackSource,
} from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
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

function createParticipantInput(frameProcessor?: FrameProcessor<AudioFrame>) {
  const source = createAudioStream();
  audioStreams.push(source.stream);

  const track = {} as RemoteTrack;
  const publication = {
    sid: 'microphone-track',
    source: TrackSource.SOURCE_MICROPHONE,
    track: track as RemoteTrack | null,
  } as RemoteTrackPublication;
  const participant = {
    identity: 'caller',
    trackPublications: new Map([[publication.sid, publication]]),
  };
  const emitter = new EventEmitter();
  const room = {
    remoteParticipants: new Map([[participant.identity, participant]]),
    on: vi.fn((event, listener) => emitter.on(event, listener)),
    off: vi.fn((event, listener) => emitter.off(event, listener)),
    emit: (event: RoomEvent, ...args: unknown[]) => emitter.emit(event, ...args),
    listenerCount: (event: RoomEvent) => emitter.listenerCount(event),
  };
  const input = new ParticipantAudioInputStream({
    room: room as unknown as Room,
    sampleRate: 24000,
    numChannels: 1,
    noiseCancellation: frameProcessor,
  });

  return { input, participant, publication, room, source, track };
}

describe('ParticipantAudioInputStream', () => {
  afterEach(() => {
    audioStreams.length = 0;
    vi.clearAllMocks();
  });

  it('unregisters track listeners when closed', async () => {
    const { input, room } = createParticipantInput();

    expect(room.listenerCount(RoomEvent.TrackSubscribed)).toBe(1);
    expect(room.listenerCount(RoomEvent.TrackUnsubscribed)).toBe(1);
    expect(room.listenerCount(RoomEvent.TrackUnpublished)).toBe(1);

    await input.close();

    expect(room.listenerCount(RoomEvent.TrackSubscribed)).toBe(0);
    expect(room.listenerCount(RoomEvent.TrackUnsubscribed)).toBe(0);
    expect(room.listenerCount(RoomEvent.TrackUnpublished)).toBe(0);
  });

  it('replaces the concrete track for the same publication', async () => {
    const { input, participant, publication, room, source, track } = createParticipantInput();
    input.setParticipant(participant.identity);
    const reader = input.stream.getReader();
    const replacement = createAudioStream();
    const replacementTrack = {} as RemoteTrack;
    audioStreams.push(replacement.stream);

    publication.track = null;
    room.emit(RoomEvent.TrackUnsubscribed, track, publication, participant);
    publication.track = replacementTrack;
    room.emit(RoomEvent.TrackSubscribed, replacementTrack, publication, participant);

    source.controller().enqueue(createFrame(1));
    const replacementFrame = createFrame(2);
    replacement.controller().enqueue(replacementFrame);
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: replacementFrame });

    reader.releaseLock();
    await input.close();
  });

  it('ignores duplicate subscribe events for the active track', async () => {
    const { input, participant, publication, room, track } = createParticipantInput();
    input.setParticipant(participant.identity);

    room.emit(RoomEvent.TrackSubscribed, track, publication, participant);

    expect(audioStreams).toHaveLength(0);
    await input.close();
  });

  it('ignores a stale unsubscribe after a same-publication replacement', async () => {
    const { input, participant, publication, room, track } = createParticipantInput();
    input.setParticipant(participant.identity);
    const reader = input.stream.getReader();
    const replacement = createAudioStream();
    const replacementTrack = {} as RemoteTrack;
    audioStreams.push(replacement.stream);

    publication.track = replacementTrack;
    room.emit(RoomEvent.TrackSubscribed, replacementTrack, publication, participant);
    room.emit(RoomEvent.TrackUnsubscribed, track, publication, participant);

    const frame = createFrame(3);
    replacement.controller().enqueue(frame);
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: frame });

    reader.releaseLock();
    await input.close();
  });

  it('closes the active track on unsubscribe', async () => {
    const { input, participant, publication, room, source, track } = createParticipantInput();
    input.setParticipant(participant.identity);
    const reader = input.stream.getReader();

    publication.track = null;
    room.emit(RoomEvent.TrackUnsubscribed, track, publication, participant);
    source.controller().enqueue(createFrame(1));
    await nextTick();

    expect(Reflect.get(input, 'publication')).toBeNull();
    expect(Reflect.get(input, 'track')).toBeNull();
    expect(Reflect.get(input, 'multiStream').inputCount).toBe(0);

    reader.releaseLock();
    await input.close();
  });

  it('keeps an owned frame processor across track replacement and closes it once', async () => {
    const frameProcessor = {
      symbol: Symbol.for('lk.frame-processor'),
      close: vi.fn(),
    } as unknown as FrameProcessor<AudioFrame>;
    const { input, participant, publication, room } = createParticipantInput(frameProcessor);
    input.setParticipant(participant.identity);
    const replacement = createAudioStream();
    const replacementTrack = {} as RemoteTrack;
    audioStreams.push(replacement.stream);

    publication.track = replacementTrack;
    room.emit(RoomEvent.TrackSubscribed, replacementTrack, publication, participant);

    expect(frameProcessor.close).not.toHaveBeenCalled();
    await input.close();
    expect(frameProcessor.close).toHaveBeenCalledOnce();
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
