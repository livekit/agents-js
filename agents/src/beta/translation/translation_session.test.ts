// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  AudioFrame,
  ParticipantKind,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type Room,
  RoomEvent,
  TrackKind,
  TrackSource,
} from '@livekit/rtc-node';
import { ReadableStream, type ReadableStreamDefaultController } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { type JobContext, runWithJobContextAsync } from '../../job.js';
import { AudioInput, AudioOutput, TextOutput } from '../../voice/io.js';
import { ParalellTextOutput, ParticipantTranscriptionOutput } from '../../voice/room_io/_output.js';
import { TranslationRoomIO, type TranslationRoomOptions } from './room_io.js';
import {
  InputSpeechStarted,
  InputSpeechStopped,
  type InputTranscript,
  OutputSpeechStopped,
  type OutputTranscript,
  type TranslatedAudioFrame,
  TranslationCapabilities,
  TranslationModel,
  type TranslationModelError,
  TranslationModelSession,
} from './translation_model.js';
import { TranslationSession } from './translation_session.js';

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

function frame(duration = 0.02, sampleRate = 16000): AudioFrame {
  const samples = Math.round(duration * sampleRate);
  return new AudioFrame(new Int16Array(samples), sampleRate, 1, samples);
}

class FakeAudioInput extends AudioInput {
  private controller!: ReadableStreamDefaultController<AudioFrame>;

  constructor() {
    super();
    this.multiStream.addInputStream(
      new ReadableStream({ start: (controller) => (this.controller = controller) }),
    );
  }

  push(value: AudioFrame): void {
    this.controller.enqueue(value);
  }
}

class FakeAudioOutput extends AudioOutput {
  frames: AudioFrame[] = [];
  pushedDuration = 0;

  constructor(sampleRate?: number) {
    super(sampleRate);
  }

  override async captureFrame(value: AudioFrame): Promise<void> {
    await super.captureFrame(value);
    this.frames.push(value);
    this.pushedDuration += value.samplesPerChannel / value.sampleRate;
  }

  override flush(): void {
    super.flush();
    if (!this.pushedDuration) return;
    const playbackPosition = this.pushedDuration;
    this.pushedDuration = 0;
    this.onPlaybackFinished({ playbackPosition, interrupted: false });
  }

  clearBuffer(): void {
    this.pushedDuration = 0;
  }
}

class FakeTextOutput extends TextOutput {
  messages: string[] = [];
  flushes = 0;

  async captureText(text: string): Promise<void> {
    this.messages.push(text);
  }

  flush(): void {
    this.flushes++;
  }
}

class RejectOnceTextOutput extends FakeTextOutput {
  private rejected = false;

  override async captureText(text: string): Promise<void> {
    if (!this.rejected) {
      this.rejected = true;
      throw new Error('sink failed');
    }
    await super.captureText(text);
  }
}

class BlockingAudioOutput extends FakeAudioOutput {
  override async captureFrame(_value: AudioFrame): Promise<void> {
    await new Promise<void>(() => {});
  }
}

class BlockingSecondAudioOutput extends FakeAudioOutput {
  private captures = 0;

  override async captureFrame(value: AudioFrame): Promise<void> {
    this.captures++;
    if (this.captures === 2) await new Promise<void>(() => {});
    else await super.captureFrame(value);
  }
}

class FakeModelSession extends TranslationModelSession {
  pushed: AudioFrame[] = [];
  retargeted: string[] = [];
  closed = false;
  private controller!: ReadableStreamDefaultController<TranslatedAudioFrame | OutputSpeechStopped>;
  private stream = new ReadableStream<TranslatedAudioFrame | OutputSpeechStopped>({
    start: (controller) => (this.controller = controller),
  });

  get audioStream(): ReadableStream<TranslatedAudioFrame | OutputSpeechStopped> {
    return this.stream;
  }

  pushAudio(value: AudioFrame): void {
    this.pushed.push(value);
  }

  override updateOptions(options: { targetLanguage: string }): void {
    if (!this.capabilities.retargetable) super.updateOptions(options);
    this.retargeted.push(options.targetLanguage);
  }

  speak(value = frame()): void {
    this.controller.enqueue({ frame: value });
  }

  endSpeech(): void {
    this.controller.enqueue(new OutputSpeechStopped());
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // The session may already have cancelled the stream reader.
    }
  }
}

class FakeModel extends TranslationModel {
  sessions: FakeModelSession[] = [];
  closed = false;

  constructor(
    options: {
      targetLanguage?: string;
      retargetable?: boolean;
      outputSegmentation?: boolean;
    } = {},
  ) {
    super({
      targetLanguage: options.targetLanguage ?? 'es',
      capabilities: new TranslationCapabilities({
        inputTranscription: true,
        outputTranscription: true,
        turnReporting: true,
        retargetable: options.retargetable,
        outputSegmentation: options.outputSegmentation,
      }),
    });
  }

  session(): FakeModelSession {
    const session = new FakeModelSession(this);
    this.sessions.push(session);
    return session;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeSession(
  model = new FakeModel(),
  options: { outputSegmentTimeout?: number } = {},
): [TranslationSession, FakeAudioInput, FakeAudioOutput, FakeTextOutput] {
  const session = new TranslationSession({ model, ...options });
  const input = new FakeAudioInput();
  const output = new FakeAudioOutput();
  const text = new FakeTextOutput();
  session.input.audio = input;
  session.output.audio = output;
  session.output.transcription = text;
  return [session, input, output, text];
}

describe('translation model and session', () => {
  it('is its own primitive and takes its target language from the model', () => {
    const model = new FakeModel({ targetLanguage: 'de' });
    const session = new TranslationSession({ model });
    expect(model.targetLanguage).toBe('de');
    expect(model.sourceLanguage).toBeUndefined();
    expect(model.capabilities.retargetable).toBe(false);
    expect(model).not.toBeInstanceOf(TranslationModelSession);
    expect(session.model).toBe(model);
  });

  it('retargets future and retargetable running sessions atomically', async () => {
    const before = new TranslationSession({ model: new FakeModel() });
    before.setTargetLanguage('fr');
    expect(before.model.targetLanguage).toBe('fr');

    const model = new FakeModel({ retargetable: true });
    const [session] = makeSession(model);
    await session.start();
    session.setTargetLanguage('fr');
    expect(model.targetLanguage).toBe('fr');
    expect(model.sessions[0]!.retargeted).toEqual(['fr']);
    await session.close();
  });

  it('refuses fixed running sessions without changing the model', async () => {
    const model = new FakeModel();
    const [session] = makeSession(model);
    await session.start();
    expect(() => session.setTargetLanguage('fr')).toThrow("fixed for the session's life");
    expect(model.targetLanguage).toBe('es');
    expect(model.sessions[0]!.retargeted).toEqual([]);
    await session.close();
    expect(() => model.session().updateOptions({ targetLanguage: 'fr' })).toThrow(
      "fixed for the session's life",
    );
  });

  it('leaves the model language unchanged when a retargetable provider refuses', async () => {
    class RefusingSession extends FakeModelSession {
      override updateOptions(options: { targetLanguage: string }): void {
        throw new Error(`${options.targetLanguage} is not available on this connection`);
      }
    }
    class RefusingModel extends FakeModel {
      override session(): FakeModelSession {
        const session = new RefusingSession(this);
        this.sessions.push(session);
        return session;
      }
    }
    const model = new RefusingModel({ retargetable: true });
    const [session] = makeSession(model);
    await session.start();
    expect(() => session.setTargetLanguage('fr')).toThrow('not available on this connection');
    expect(model.targetLanguage).toBe('es');
    await session.close();
  });

  it('forwards source and translated audio', async () => {
    const model = new FakeModel();
    const [session, input, output] = makeSession(model);
    await session.start();
    input.push(frame());
    input.push(frame());
    await vi.waitFor(() => expect(model.sessions[0]!.pushed).toHaveLength(2));
    model.sessions[0]!.speak();
    await vi.waitFor(() => expect(output.frames).toHaveLength(1));
    await session.close();
  });

  it('reports both transcripts and forwards translated text', async () => {
    const model = new FakeModel();
    const [session, , , text] = makeSession(model);
    const heard = vi.fn();
    const spoken = vi.fn();
    session.on('user_input_transcribed', heard);
    session.on('translation_transcribed', spoken);
    await session.start();
    model.sessions[0]!.emit('input_transcript', {
      text: 'hello',
      isFinal: true,
      language: 'en',
      speakerId: 'speaker',
    } satisfies InputTranscript);
    model.sessions[0]!.emit('output_transcript', {
      text: 'hola',
      isFinal: true,
    } satisfies OutputTranscript);
    expect(heard.mock.calls[0]![0]).toMatchObject({
      transcript: 'hello',
      isFinal: true,
      language: 'en',
      speakerId: 'speaker',
    });
    expect(spoken.mock.calls[0]![0]).toMatchObject({
      transcript: 'hola',
      isFinal: true,
      language: 'es',
    });
    await vi.waitFor(() => expect(text.messages).toEqual(['hola']));
    expect(text.flushes).toBe(1);
    await session.close();
  });

  it('continues forwarding transcripts after a sink rejection and on restart', async () => {
    const model = new FakeModel();
    const session = new TranslationSession({ model });
    const text = new RejectOnceTextOutput();
    session.input.audio = new FakeAudioInput();
    session.output.audio = new FakeAudioOutput();
    session.output.transcription = text;
    await session.start();
    model.sessions[0]!.emit('output_transcript', { text: 'drop', isFinal: false });
    model.sessions[0]!.emit('output_transcript', { text: 'kept', isFinal: true });
    await vi.waitFor(() => expect(text.messages).toEqual(['kept']));
    await session.close();

    await session.start();
    model.sessions[1]!.emit('output_transcript', { text: 'again', isFinal: true });
    await vi.waitFor(() => expect(text.messages).toEqual(['kept', 'again']));
    await session.close();
  });

  it('drives user state from model turn reports', async () => {
    const model = new FakeModel();
    const [session] = makeSession(model);
    const states: string[] = [];
    session.on('user_state_changed', (event) => states.push(event.newState));
    await session.start();
    expect(session.userState).toBe('listening');
    model.sessions[0]!.emit('input_speech_started', new InputSpeechStarted());
    expect(session.userState).toBe('speaking');
    model.sessions[0]!.emit('input_speech_stopped', new InputSpeechStopped());
    expect(session.userState).toBe('listening');
    expect(states).toEqual(['speaking', 'listening']);
    await session.close();
  });

  it('keeps ordered provider boundaries behind all audio', async () => {
    const model = new FakeModel({ outputSegmentation: true });
    const [session, , output] = makeSession(model);
    const played: number[] = [];
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, (event) => played.push(event.playbackPosition));
    await session.start();
    model.sessions[0]!.speak();
    model.sessions[0]!.speak();
    model.sessions[0]!.speak();
    model.sessions[0]!.endSpeech();
    await vi.waitFor(() => expect(played).toHaveLength(1));
    expect(played[0]).toBeCloseTo(0.06);
    await session.close();
  });

  it('does not run a silence timer for provider-segmented output', async () => {
    const model = new FakeModel({ outputSegmentation: true });
    const [session, , output] = makeSession(model, { outputSegmentTimeout: 20 });
    const played = vi.fn();
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, played);
    await session.start();
    model.sessions[0]!.speak();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(played).not.toHaveBeenCalled();
    model.sessions[0]!.endSpeech();
    await vi.waitFor(() => expect(played).toHaveBeenCalledOnce());
    await session.close();
  });

  it('ends unsegmented output after model silence', async () => {
    const model = new FakeModel();
    const [session, , output] = makeSession(model, { outputSegmentTimeout: 20 });
    const played = vi.fn();
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, played);
    await session.start();
    model.sessions[0]!.speak();
    await vi.waitFor(() => expect(played).toHaveBeenCalledOnce());
    await session.close();
  });

  it('honors a speech boundary while output is muted', async () => {
    const model = new FakeModel({ outputSegmentation: true });
    const [session, , output] = makeSession(model);
    const played = vi.fn();
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, played);
    await session.start();
    model.sessions[0]!.speak();
    await vi.waitFor(() => expect(output.frames).toHaveLength(1));
    session.output.setAudioEnabled(false);
    model.sessions[0]!.endSpeech();
    await vi.waitFor(() => expect(played).toHaveBeenCalledOnce());
    await session.close();
  });

  it('reports close reasons, errors, and leaves model ownership with the caller', async () => {
    const model = new FakeModel();
    const [session] = makeSession(model);
    const closes = vi.fn();
    session.on('close', closes);
    await session.start();
    await session.close();
    expect(closes.mock.calls[0]![0].reason).toBe('user_initiated');
    expect(model.sessions[0]!.closed).toBe(true);
    expect(model.closed).toBe(false);

    const failing = new FakeModel();
    const [failed] = makeSession(failing);
    const errors = vi.fn();
    const failedClose = vi.fn();
    failed.on('error', errors);
    failed.on('close', failedClose);
    await failed.start();
    failing.sessions[0]!.emit('error', {
      type: 'translation_model_error',
      timestamp: 0,
      label: failing.label,
      error: new Error('gone'),
      recoverable: false,
    } satisfies TranslationModelError);
    await vi.waitFor(() => expect(failedClose).toHaveBeenCalledOnce());
    expect(errors).toHaveBeenCalledOnce();
    expect(failedClose.mock.calls[0]![0].reason).toBe('error');
  });

  it('only reports recoverable errors and treats a second start as a no-op', async () => {
    const model = new FakeModel();
    const [session] = makeSession(model);
    const closes = vi.fn();
    session.on('close', closes);
    await session.start();
    await session.start();
    expect(model.sessions).toHaveLength(1);
    model.sessions[0]!.emit('error', {
      type: 'translation_model_error',
      timestamp: 0,
      label: model.label,
      error: new Error('blip'),
      recoverable: true,
    });
    await nextTick();
    expect(closes).not.toHaveBeenCalled();
    await session.close();
  });

  it('retains caller devices and restarts on them', async () => {
    const model = new FakeModel();
    const [session, input, output, text] = makeSession(model);
    await session.start();
    await session.close();
    expect(session.input.audio).toBe(input);
    expect(session.output.audio).toBe(output);
    expect(session.output.transcription).toBe(text);
    await session.start();
    input.push(frame());
    await vi.waitFor(() => expect(model.sessions[1]!.pushed).toHaveLength(1));
    model.sessions[1]!.speak();
    await vi.waitFor(() => expect(output.frames).toHaveLength(1));
    await session.close();
  });

  it('closes without owning or waiting for a blocked caller audio output', async () => {
    const model = new FakeModel();
    const session = new TranslationSession({ model });
    const output = new BlockingAudioOutput();
    session.input.audio = new FakeAudioInput();
    session.output.audio = output;
    await session.start();
    model.sessions[0]!.speak();
    await nextTick();

    await expect(
      Promise.race([
        session.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('standalone translation close timed out')), 500),
        ),
      ]),
    ).resolves.toBeUndefined();
    expect(session.output.audio).toBe(output);
  });

  it('cancels blocked output before joining a segment task waiting for its lock', async () => {
    const model = new FakeModel();
    const session = new TranslationSession({ model, outputSegmentTimeout: 100 });
    const output = new BlockingSecondAudioOutput();
    session.input.audio = new FakeAudioInput();
    session.output.audio = output;
    await session.start();
    model.sessions[0]!.speak();
    await vi.waitFor(() => expect(output.frames).toHaveLength(1));
    model.sessions[0]!.speak();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await vi.waitFor(() =>
      expect((session as unknown as { segmentTasks: Set<Promise<void>> }).segmentTasks.size).toBe(
        1,
      ),
    );

    await expect(
      Promise.race([
        session.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('segment teardown timed out')), 500),
        ),
      ]),
    ).resolves.toBeUndefined();
  });

  it('rolls back room I/O when job connection fails and can restart', async () => {
    const model = new FakeModel();
    const session = new TranslationSession({ model });
    const room = fakeRoom();
    const job = {
      connect: vi.fn(async () => {
        throw new Error('connect failed');
      }),
      addShutdownCallback: vi.fn(),
    } as unknown as JobContext;

    await expect(
      runWithJobContextAsync(job, () =>
        session.start({
          room,
          roomOptions: { audioInput: false, textOutput: false },
        }),
      ),
    ).rejects.toThrow('connect failed');
    expect(session.roomIO).toBeNull();
    expect(session.output.audio).toBeNull();
    expect(room.off).toHaveBeenCalledWith(RoomEvent.TrackPublished, expect.any(Function));

    await session.start();
    expect(model.sessions).toHaveLength(1);
    await session.close();
  });

  it('rolls back room I/O when model session creation fails and can restart', async () => {
    class FailOnceModel extends FakeModel {
      private failed = false;

      override session(): FakeModelSession {
        if (!this.failed) {
          this.failed = true;
          throw new Error('session failed');
        }
        return super.session();
      }
    }

    const model = new FailOnceModel();
    const session = new TranslationSession({ model });
    const room = fakeRoom();
    await expect(
      session.start({
        room,
        roomOptions: { audioInput: false, audioOutput: false, textOutput: false },
      }),
    ).rejects.toThrow('session failed');
    expect(session.roomIO).toBeNull();
    expect(room.off).toHaveBeenCalledWith(RoomEvent.TrackPublished, expect.any(Function));

    await session.start();
    expect(model.sessions).toHaveLength(1);
    await session.close();
  });
});

describe('translation output audio ownership', () => {
  it('resamples to the sink rate and passes native-rate frames through', async () => {
    const model = new FakeModel({ outputSegmentation: true });
    const session = new TranslationSession({ model });
    const output = new FakeAudioOutput(24000);
    session.input.audio = new FakeAudioInput();
    session.output.audio = output;
    await session.start();
    model.sessions[0]!.speak(frame(0.1, 16000));
    model.sessions[0]!.endSpeech();
    await vi.waitFor(() => expect(output.frames.length).toBeGreaterThan(0));
    expect(new Set(output.frames.map((value) => value.sampleRate))).toEqual(new Set([24000]));
    await session.close();

    const nativeModel = new FakeModel({ outputSegmentation: true });
    const nativeSession = new TranslationSession({ model: nativeModel });
    const nativeOutput = new FakeAudioOutput(24000);
    nativeSession.input.audio = new FakeAudioInput();
    nativeSession.output.audio = nativeOutput;
    await nativeSession.start();
    const sent = frame(0.1, 24000);
    nativeModel.sessions[0]!.speak(sent);
    await vi.waitFor(() => expect(nativeOutput.frames).toHaveLength(1));
    expect(nativeOutput.frames[0]).toBe(sent);
    await nativeSession.close();
  });

  it('rebuilds resampling for a replacement sink and keeps the old tail on its owner', async () => {
    const model = new FakeModel({ outputSegmentation: true });
    const session = new TranslationSession({ model });
    const first = new FakeAudioOutput(24000);
    session.input.audio = new FakeAudioInput();
    session.output.audio = first;
    await session.start();
    model.sessions[0]!.speak(frame(0.03, 16000));
    await vi.waitFor(() =>
      expect((session as unknown as { resampler: unknown }).resampler).not.toBeNull(),
    );
    const second = new FakeAudioOutput(48000);
    session.output.audio = second;
    model.sessions[0]!.speak(frame(0.1, 16000));
    await vi.waitFor(() => expect(second.frames.length).toBeGreaterThan(0));
    expect(new Set(first.frames.map((value) => value.sampleRate))).toEqual(new Set([24000]));
    expect(new Set(second.frames.map((value) => value.sampleRate))).toEqual(new Set([48000]));
    await session.close();
  });

  it('closes a native-rate segment on its old sink when output is replaced', async () => {
    const model = new FakeModel({ outputSegmentation: true });
    const session = new TranslationSession({ model });
    const first = new FakeAudioOutput(16000);
    const second = new FakeAudioOutput(16000);
    const firstPlayed = vi.fn();
    const secondPlayed = vi.fn();
    first.on(AudioOutput.EVENT_PLAYBACK_FINISHED, firstPlayed);
    second.on(AudioOutput.EVENT_PLAYBACK_FINISHED, secondPlayed);
    session.input.audio = new FakeAudioInput();
    session.output.audio = first;
    await session.start();
    model.sessions[0]!.speak(frame(0.02, 16000));
    await vi.waitFor(() => expect(first.frames).toHaveLength(1));

    session.output.audio = second;
    model.sessions[0]!.speak(frame(0.02, 16000));
    await vi.waitFor(() => expect(second.frames).toHaveLength(1));
    expect(firstPlayed).toHaveBeenCalledOnce();
    expect(firstPlayed.mock.calls[0]![0].playbackPosition).toBeCloseTo(0.02);

    model.sessions[0]!.endSpeech();
    await vi.waitFor(() => expect(secondPlayed).toHaveBeenCalledOnce());
    expect(secondPlayed.mock.calls[0]![0].playbackPosition).toBeCloseTo(0.02);
    await session.close();
  });

  it('drains a resampler tail into the segment closed by the silence timer', async () => {
    const model = new FakeModel();
    const session = new TranslationSession({ model, outputSegmentTimeout: 20 });
    const output = new FakeAudioOutput(24000);
    session.input.audio = new FakeAudioInput();
    session.output.audio = output;
    const played = vi.fn();
    output.on(AudioOutput.EVENT_PLAYBACK_FINISHED, played);
    await session.start();
    model.sessions[0]!.speak(frame(0.03, 16000));
    await vi.waitFor(() => expect(played).toHaveBeenCalledOnce());
    expect((session as unknown as { resampler: unknown }).resampler).toBeNull();
    expect(output.frames.length).toBeGreaterThan(0);
    expect(new Set(output.frames.map((value) => value.sampleRate))).toEqual(new Set([24000]));
    await session.close();
  });
});

type FakePublication = RemoteTrackPublication & {
  sid: string;
  kind: TrackKind;
  source: TrackSource;
};

function publication(
  sid: string,
  kind = TrackKind.KIND_AUDIO,
  source = TrackSource.SOURCE_MICROPHONE,
): FakePublication {
  return { sid, kind, source } as FakePublication;
}

function participant(identity: string): RemoteParticipant {
  return {
    identity,
    kind: ParticipantKind.STANDARD,
    info: { kind: ParticipantKind.STANDARD },
    attributes: {},
    trackPublications: new Map(),
  } as unknown as RemoteParticipant;
}

function fakeRoom(participants: RemoteParticipant[] = []): Room {
  return {
    name: 'room',
    isConnected: false,
    localParticipant: { identity: 'agent' },
    remoteParticipants: new Map(participants.map((value) => [value.identity, value])),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Room;
}

function roomIO(options: TranslationRoomOptions = {}, room = fakeRoom()): TranslationRoomIO {
  return new TranslationRoomIO(new TranslationSession({ model: new FakeModel() }), room, options);
}

describe('track-based translation room selection', () => {
  it('takes a named audio track whoever published it', () => {
    const io = roomIO({ track: 'TR_wanted' });
    const speaker = participant('speaker');
    io._onTrackPublished(publication('TR_other'), speaker);
    expect(io.linkedTrack).toBeNull();
    const wanted = publication('TR_wanted');
    io._onTrackPublished(wanted, speaker);
    expect(io.linkedTrack?.publication).toBe(wanted);
    expect(io.linkedParticipant).toBe(speaker);
  });

  it('never auto-selects video or screenshare audio', () => {
    const io = roomIO({ participantIdentity: 'speaker' });
    const speaker = participant('speaker');
    io._onTrackPublished(publication('video', TrackKind.KIND_VIDEO), speaker);
    io._onTrackPublished(
      publication('screen', TrackKind.KIND_AUDIO, TrackSource.SOURCE_SCREENSHARE_AUDIO),
      speaker,
    );
    expect(io.linkedTrack).toBeNull();
    const mic = publication('mic');
    io._onTrackPublished(mic, speaker);
    expect(io.linkedTrack?.publication).toBe(mic);
  });

  it('narrows automatic selection but lets an exact SID ignore the participant filter', () => {
    const automatic = roomIO({ participantIdentity: 'speaker' });
    automatic._onTrackPublished(publication('a'), participant('other'));
    expect(automatic.linkedTrack).toBeNull();
    automatic._onTrackPublished(publication('b'), participant('speaker'));
    expect(automatic.linkedTrack?.publication.sid).toBe('b');

    const exact = roomIO({ track: 'screen', participantIdentity: 'speaker' });
    exact._onTrackPublished(
      publication('screen', TrackKind.KIND_AUDIO, TrackSource.SOURCE_SCREENSHARE_AUDIO),
      participant('other'),
    );
    expect(exact.linkedParticipant?.identity).toBe('other');
  });

  it('moves audio selection and transcript attribution together', () => {
    const io = roomIO();
    const audio = { setTrackSid: vi.fn(), setParticipant: vi.fn() };
    const transcriptSink = Object.create(ParticipantTranscriptionOutput.prototype) as {
      setLink: ReturnType<typeof vi.fn>;
    };
    transcriptSink.setLink = vi.fn();
    const transcript = { _sinks: [transcriptSink] };
    Object.assign(io as unknown as Record<string, unknown>, {
      _audioInput: audio,
      inputTranscriptOutput: transcript,
    });
    const bob = participant('bob');
    io._applyLink({ publication: publication('TR_b'), participant: bob });
    expect(audio.setTrackSid).toHaveBeenCalledWith('TR_b');
    expect(audio.setParticipant).toHaveBeenCalledWith('bob');
    expect(transcriptSink.setLink).toHaveBeenCalledWith('bob', 'TR_b');
  });

  it('links a named track published after startup and pins an already linked track', () => {
    const io = roomIO({ track: 'TR_late' });
    const audio = { setTrackSid: vi.fn(), setParticipant: vi.fn() };
    const transcriptSink = Object.create(ParticipantTranscriptionOutput.prototype) as {
      setLink: ReturnType<typeof vi.fn>;
    };
    transcriptSink.setLink = vi.fn();
    Object.assign(io as unknown as Record<string, unknown>, {
      _audioInput: audio,
      inputTranscriptOutput: { _sinks: [transcriptSink] },
      initTask: { done: true },
    });
    io._onTrackPublished(publication('TR_late'), participant('bob'));
    expect(audio.setParticipant).toHaveBeenCalledWith('bob');
    expect(transcriptSink.setLink).toHaveBeenCalledWith('bob', 'TR_late');
    io.setTrack('TR_late');
    expect(audio.setTrackSid).toHaveBeenLastCalledWith('TR_late');
  });

  it('rejects switching to a known video publication', () => {
    const bob = participant('bob');
    bob.trackPublications.set('camera', publication('camera', TrackKind.KIND_VIDEO));
    const io = roomIO({}, fakeRoom([bob]));
    expect(() => io.setTrack('camera')).toThrow('not audio');
  });

  it('configures input to accept an explicitly selected screenshare track', async () => {
    const io = roomIO({ audioOutput: false, textOutput: false });
    await io.start();
    const sources = (io.audioInput as unknown as { acceptedSources: Set<TrackSource> })
      .acceptedSources;
    expect(sources.has(TrackSource.SOURCE_MICROPHONE)).toBe(true);
    expect(sources.has(TrackSource.SOURCE_SCREENSHARE_AUDIO)).toBe(true);
    await io.close();
  });

  it('recovers input transcript forwarding after a room sink rejection', async () => {
    const session = new TranslationSession({ model: new FakeModel() });
    const io = new TranslationRoomIO(session, fakeRoom(), {
      audioInput: false,
      audioOutput: false,
      textOutput: false,
    });
    const sink = new RejectOnceTextOutput();
    Object.assign(io as unknown as Record<string, unknown>, {
      inputTranscriptOutput: new ParalellTextOutput([sink]),
    });
    await io.start();
    session.emit('user_input_transcribed', {
      type: 'user_input_transcribed',
      transcript: 'drop',
      isFinal: false,
      itemId: null,
      speakerId: null,
      language: null,
      createdAt: Date.now(),
    });
    session.emit('user_input_transcribed', {
      type: 'user_input_transcribed',
      transcript: 'kept',
      isFinal: true,
      itemId: null,
      speakerId: null,
      language: null,
      createdAt: Date.now(),
    });
    await vi.waitFor(() => expect(sink.messages).toEqual(['kept']));
    expect(sink.flushes).toBe(1);
    await io.close();
  });

  it('forwards translated text to textOutput.nextInChain', async () => {
    const model = new FakeModel();
    const session = new TranslationSession({ model });
    const next = new FakeTextOutput();
    await session.start({
      room: fakeRoom(),
      roomOptions: {
        audioInput: false,
        audioOutput: false,
        textOutput: { syncTranscription: false, nextInChain: next },
      },
    });
    model.sessions[0]!.emit('output_transcript', { text: 'hola', isFinal: true });
    await vi.waitFor(() => expect(next.messages).toEqual(['hola']));
    expect(next.flushes).toBe(1);
    await session.close();
  });

  it('closes while room audio publication is still waiting for a subscriber', async () => {
    const speaker = participant('speaker');
    speaker.trackPublications.set('mic', publication('mic'));
    const room = fakeRoom([speaker]) as Room & Record<string, unknown>;
    const waitForSubscription = vi.fn(() => new Promise<void>(() => {}));
    Object.assign(room, {
      isConnected: true,
      localParticipant: {
        identity: 'agent',
        publishTrack: vi.fn(async () => ({ sid: 'local', waitForSubscription })),
      },
    });
    const model = new FakeModel();
    const session = new TranslationSession({ model });
    await session.start({
      room,
      roomOptions: { audioInput: false, textOutput: false },
    });
    model.sessions[0]!.speak();
    await vi.waitFor(() => expect(waitForSubscription).toHaveBeenCalledOnce());

    await expect(
      Promise.race([
        session.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('translation close timed out')), 500),
        ),
      ]),
    ).resolves.toBeUndefined();
  });
});

describe('transcript metadata finalization', () => {
  it('finalizes a TranslationRoomIO segment using its old track and sender', async () => {
    const output = Object.create(ParticipantTranscriptionOutput.prototype) as Record<
      string,
      unknown
    >;
    Object.assign(output, {
      participantIdentity: 'alice',
      pinnedTrackId: 'TR_a',
      trackId: 'TR_a',
      capturing: true,
      writer: null,
      currentId: 'SG_a',
      latestText: 'hello',
      isDeltaStream: true,
      expressiveEnabled: () => false,
      stripper: { flush: () => '', tags: [] },
      segmentTags: [],
    });
    const finalized: unknown[][] = [];
    output.flushTaskImpl = async (...args: unknown[]) => {
      finalized.push(args);
    };
    const io = roomIO();
    Object.assign(io as unknown as Record<string, unknown>, {
      inputTranscriptOutput: { _sinks: [output] },
    });
    io._applyLink({ publication: publication('TR_b'), participant: participant('bob') });
    await (output.flushTask as { result: Promise<void> }).result;
    expect(finalized[0]![4]).toBe('TR_a');
    expect(finalized[0]![5]).toBe('alice');
    expect(output.pinnedTrackId).toBe('TR_b');
    expect(output.participantIdentity).toBe('bob');
  });
});
