// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Ported from Python `tests/test_amd_stt.py`: transcript attribution in AMDTranscriber. */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { asLanguageCode } from '../../language.js';
import { SpeechEventType } from '../../stt/stt.js';
import { DEFAULT_API_CONNECT_OPTIONS } from '../../types.js';
import { delay } from '../../utils.js';
import { DrainingSTT, type DrainingStream, audioFrame, eventually } from './amd_test_utils.js';
import { AMDTranscript } from './chat_context.js';
import { AMDTranscriber } from './stt.js';

const CONN_OPTIONS = { ...DEFAULT_API_CONNECT_OPTIONS, maxRetry: 0 };

/** The transcripts buffered for the open turn. */
function current(transcriber: AMDTranscriber, source: 'session' | 'amd'): string {
  return (
    transcriber as unknown as { current: { get(source: 'session' | 'amd'): string } }
  ).current.get(source);
}

function sendInterim(stream: DrainingStream, transcript: string): void {
  (stream as unknown as { queue: { put(event: unknown): void } }).queue.put({
    type: SpeechEventType.INTERIM_TRANSCRIPT,
    alternatives: [
      { text: transcript, language: asLanguageCode(''), startTime: 0, endTime: 0, confidence: 1 },
    ],
  });
}

function streamClosed(stream: DrainingStream): boolean {
  return (stream as unknown as { closed: boolean }).closed;
}

/** A transcriber with an open AMD stream, closed when the test finishes. */
function transcriber(): [AMDTranscriber, DrainingStream] {
  const model = new DrainingSTT();
  const amd = new AMDTranscriber(model, CONN_OPTIONS);
  onTestFinished(async () => {
    await amd.aclose();
    await model.close();
  });
  amd.pushAudio(audioFrame());
  return [amd, model.streams[0]!];
}

async function amdHeard(amd: AMDTranscriber, stream: DrainingStream, text: string): Promise<void> {
  const before = current(amd, 'amd');
  stream.sendFinal(text);
  await eventually(() => current(amd, 'amd') !== before, 1_000);
}

describe('AMDTranscriber', () => {
  it.each([true, false])(
    'each turn keeps both transcripts whichever arrives first (session first %s)',
    async (sessionFirst) => {
      const [amd, stream] = transcriber();
      if (sessionFirst) {
        amd.pushTranscript('session transcript');
      }
      await amdHeard(amd, stream, 'amd transcript');
      const first = amd.endTurn('session transcript');
      expect(first).toEqual(new AMDTranscript('session transcript', 'amd transcript'));

      await amdHeard(amd, stream, 'amd next turn');
      const second = amd.endTurn('session next turn');
      expect(second).toEqual(new AMDTranscript('session next turn', 'amd next turn'));
      expect(amd.amdSttActive).toBe(true);
    },
  );

  it('a late amd transcript leaves the session transcript', async () => {
    const [amd, stream] = transcriber();
    await amdHeard(amd, stream, "Hi, you've reached Sam.");
    const first = amd.endTurn("Hi, you've reached Sam.");
    const second = amd.endTurn('Leave your name and number.');
    expect(first.amd).toBe("Hi, you've reached Sam.");
    expect(second).toEqual(new AMDTranscript('Leave your name and number.', ''));
    expect(second.transcript).toBe('Leave your name and number.');

    // the late words belong to the next turn
    await amdHeard(amd, stream, 'Leave your name and number.');
    expect(amd.endTurn('').amd).toBe('Leave your name and number.');
  });

  it('a final within the wait belongs to the turn just ended', async () => {
    const [amd, stream] = transcriber();
    const ended = amd.endTurn('Sam Lee speaking.', { lateWait: 300 });
    expect(ended).toEqual(new AMDTranscript('Sam Lee speaking.', ''));
    const late = amd.lateFinal;
    expect(late).toBeDefined();
    const waiting = late!.wait();
    await delay(100);
    stream.sendFinal('Sam Lee speaking.');
    expect(await waiting).toBe('Sam Lee speaking.');
    // the next turn starts clean
    await amdHeard(amd, stream, 'Yes, that works.');
    expect(amd.endTurn('Yes, that works.').amd).toBe('Yes, that works.');
  });

  it('a final after the wait belongs to the next turn', async () => {
    const [amd, stream] = transcriber();
    amd.endTurn('Sam Lee speaking.', { lateWait: 300 });
    const late = amd.lateFinal;
    expect(late).toBeDefined();
    expect(await late!.wait()).toBeUndefined();
    await amdHeard(amd, stream, 'Sam Lee speaking.');
    expect(amd.endTurn('Yes.').amd).toBe('Sam Lee speaking.');
  });

  it('a final before the wait starts still belongs to the turn', async () => {
    const [amd, stream] = transcriber();
    amd.endTurn('Sam Lee speaking.', { lateWait: 300 });
    const late = amd.lateFinal;
    expect(late).toBeDefined();
    stream.sendFinal('Sam Lee speaking.');
    await eventually(() => amd.lateFinal === undefined, 1_000);
    expect(await late!.wait()).toBe('Sam Lee speaking.');
    expect(amd.endTurn('').amd).toBe('');
  });

  it('without session stt a final after the wait belongs to the next turn', async () => {
    const model = new DrainingSTT();
    const amd = new AMDTranscriber(model, CONN_OPTIONS, { sessionStt: false });
    try {
      amd.pushAudio(audioFrame());
      amd.endTurn('Sam Lee speaking.', { lateWait: 300 });
      const late = amd.lateFinal;
      expect(late).toBeDefined();
      expect(await late!.wait()).toBeUndefined();
      await amdHeard(amd, model.streams[0]!, 'Sam Lee speaking.');
      expect(amd.endTurn('').amd).toBe('Sam Lee speaking.');
    } finally {
      await amd.aclose();
      await model.close();
    }
  });

  it('a turn with its amd final needs no wait', async () => {
    const [amd, stream] = transcriber();
    await amdHeard(amd, stream, 'Sam Lee speaking.');
    amd.endTurn('Sam Lee speaking.', { lateWait: 300 });
    expect(amd.lateFinal).toBeUndefined();
  });

  it('the classifier sees both transcripts only with an amd stt', () => {
    expect(new AMDTranscript('Hi.').forClassifier()).toBe('Hi.');
    expect(new AMDTranscript(null, 'Hi.').forClassifier()).toBe('Hi.');
    expect(new AMDTranscript('Hi.', 'Hi.').forClassifier()).toBe(
      '{"transcript_1": "Hi.", "transcript_2": "Hi."}',
    );
    expect(new AMDTranscript('Hi.', '').forClassifier()).toBe(
      '{"transcript_1": "Hi.", "transcript_2": ""}',
    );
    expect(new AMDTranscript('', 'Hi.').transcript).toBe('Hi.');
  });

  it('without session stt amd uses its own transcript until it fails', async () => {
    const model = new DrainingSTT();
    const amd = new AMDTranscriber(model, CONN_OPTIONS, { sessionStt: false });
    try {
      amd.pushAudio(audioFrame());
      amd.pushTranscript('Session transcript.');
      expect(amd.endTurn('Session transcript.')).toEqual(new AMDTranscript(null, ''));

      await amdHeard(amd, model.streams[0]!, 'AMD transcript.');
      expect(amd.endTurn('Session transcript.')).toEqual(
        new AMDTranscript(null, 'AMD transcript.'),
      );

      amd.pushTranscript('Fallback transcript.');
      amd.fail(new Error('connection lost'));
      expect(amd.endTurn('')).toEqual(new AMDTranscript('Fallback transcript.', null));
    } finally {
      await amd.aclose();
    }
  });

  it.each(['no_audio', 'reader_pending', 'reader_running', 'amd_heard'])(
    'close stops stream and prevents more audio (%s)',
    async (started) => {
      const model = new DrainingSTT();
      const modelClose = vi.spyOn(model, 'close');
      const frame = audioFrame();
      const amd = new AMDTranscriber(model, CONN_OPTIONS);
      let stream: DrainingStream | undefined;
      let streamClose: ReturnType<typeof vi.spyOn> | undefined;
      let pushFrame: ReturnType<typeof vi.spyOn> | undefined;
      try {
        if (started !== 'no_audio') {
          amd.pushAudio(frame);
          stream = model.streams[0]!;
          streamClose = vi.spyOn(stream, 'close');
          pushFrame = vi.spyOn(stream, 'pushFrame');
          if (started === 'reader_running' || started === 'amd_heard') {
            await eventually(() => stream!.frames.length > 0, 1_000);
          }
          if (started === 'amd_heard') {
            amd.pushTranscript('Hello from AMD.', { source: 'amd' });
          }
        }

        await amd.aclose();
        amd.pushAudio(frame);
        await amd.aclose();
        amd.pushAudio(frame);

        if (stream !== undefined) {
          // JS closes the stream from both closeStream() and the reader; close() is idempotent
          expect(streamClose).toHaveBeenCalled();
          expect(pushFrame).not.toHaveBeenCalled();
          expect(streamClosed(stream)).toBe(true);
        }
        expect(model.streams).toHaveLength(started === 'no_audio' ? 0 : 1);
      } finally {
        await amd.aclose();
      }
      expect(modelClose).not.toHaveBeenCalled();
      await model.close();
    },
  );

  it('turns commit immediately without flushing stt', async () => {
    const [amd, stream] = transcriber();
    const flush = vi.spyOn(stream, 'flush');
    expect(amd.endTurn('')).toEqual(new AMDTranscript('', ''));

    await amdHeard(amd, stream, 'Hello.');
    expect(amd.endTurn('Hello from session.')).toEqual(
      new AMDTranscript('Hello from session.', 'Hello.'),
    );
    expect(flush).not.toHaveBeenCalled();
    expect(stream.inputEnded.isSet).toBe(false);
  });

  it('late final after empty turns belongs to the next turn', async () => {
    const [amd, stream] = transcriber();
    const earlier = [amd.endTurn(''), amd.endTurn(''), amd.endTurn('')];
    await amdHeard(amd, stream, 'Hello.');
    expect(amd.endTurn('').amd).toBe('Hello.');
    expect(earlier.every((turn) => turn.transcript === '')).toBe(true);
  });

  it('final segments accumulate and ignore interim transcript', async () => {
    const [amd, stream] = transcriber();
    sendInterim(stream, 'partial');
    stream.sendFinal('');
    stream.sendFinal('Please leave');
    stream.sendFinal('a message.');
    await eventually(() => current(amd, 'amd') === 'Please leave a message.', 1_000);
    expect(amd.endTurn('Leave a message.')).toEqual(
      new AMDTranscript('Leave a message.', 'Please leave a message.'),
    );
  });

  it('amd failure leaves the session transcript for the open turn on', async () => {
    const [amd, stream] = transcriber();
    await amdHeard(amd, stream, 'Hello.');
    const first = amd.endTurn('Hello from session.');
    amd.pushTranscript('Session turn two.');

    stream.error = new Error('connection lost');
    amd.pushAudio(audioFrame());
    await eventually(() => !amd.amdSttActive, 1_000);
    const second = amd.endTurn('');
    expect(first).toEqual(new AMDTranscript('Hello from session.', 'Hello.'));
    expect(second).toEqual(new AMDTranscript('Session turn two.', null));
    expect(amd.endTurn('Session turn three.').amd).toBeNull();
  });

  it.each(['push', 'read'])(
    'failure drops the amd transcript even when the session is empty (%s)',
    async (failure) => {
      const [amd, stream] = transcriber();
      await amdHeard(amd, stream, 'Please leave a message.');
      if (failure === 'push') {
        vi.spyOn(stream, 'pushFrame').mockImplementation(() => {
          throw new Error('failed to push');
        });
      } else {
        stream.error = new Error('connection lost');
      }
      amd.pushAudio(audioFrame());
      await eventually(() => !amd.amdSttActive, 1_000);
      expect(amd.endTurn('')).toEqual(new AMDTranscript('', null));
      expect(amd.endTurn('Session transcript.')).toEqual(
        new AMDTranscript('Session transcript.', null),
      );
    },
  );

  it('stream open failure keeps session transcript', async () => {
    const model = new DrainingSTT();
    const stream = vi.spyOn(model, 'stream').mockImplementation(() => {
      throw new Error('failed to open');
    });
    const amd = new AMDTranscriber(model, CONN_OPTIONS);
    try {
      amd.pushAudio(audioFrame());
      amd.pushAudio(audioFrame());
      expect(stream).toHaveBeenCalledOnce();
      expect(amd.endTurn('Hello.')).toEqual(new AMDTranscript('Hello.', null));
    } finally {
      await amd.aclose();
    }
    await model.close();
  });
});
