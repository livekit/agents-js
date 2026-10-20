// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for livekit/agents-js#2566.
 *
 * When reply B's text reaches the transcription synchronizer before reply A's
 * playback_finished, A is rotated out and its finish is settled later. That finish
 * resolves whichever `waitForPlayout()` is pending, so an interrupted reply can receive
 * another segment's playout event. Only the reply knows whether the event is its own:
 * it is when the reply bumped the output's segment count. `ownSynchronizedTranscript`
 * keeps the transcript in that case and drops it otherwise, so the reply commits its own
 * text instead of the previous reply's.
 */
import { AudioFrame } from '@livekit/rtc-node';
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeLogger } from '../log.js';
import { Future } from '../utils.js';
import { type _AudioOut, ownSynchronizedTranscript } from './generation.js';
import { AudioOutput, TextOutput, type TimedString, isTimedString } from './io.js';
import { TranscriptionSynchronizer } from './transcription/synchronizer.js';

class MockTextOutput extends TextOutput {
  captured: string[] = [];
  async captureText(text: string | TimedString): Promise<void> {
    this.captured.push(isTimedString(text) ? text.text : text);
  }
  flush(): void {}
}

class PassthroughAudioOutput extends AudioOutput {
  constructor() {
    super(8000);
  }
  clearBuffer(): void {}
}

function audioOutFor(output: AudioOutput): _AudioOut {
  return {
    firstFrameFut: new Future<number>(),
    _hasCapturedOwnFrame: false,
    capturedSegmentsBefore: output.capturedPlayoutSegments,
  };
}

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

describe('ownSynchronizedTranscript', () => {
  it("does not hand a rotated-out segment's transcript to the next reply (#2566)", async () => {
    const downstream = new PassthroughAudioOutput();
    const synchronizer = new TranscriptionSynchronizer(downstream, new MockTextOutput());
    const audioOutput = synchronizer.audioOutput;
    const frame = new AudioFrame(new Int16Array(160), 8000, 1, 160);

    // reply A: text + audio; its playback_finished has not arrived yet
    await synchronizer.textOutput.captureText('REPLY_A_TEXT');
    synchronizer.textOutput.flush();
    await audioOutput.captureFrame(frame);
    audioOutput.flush();

    // reply B sets up forwarding, then its text rotates A out; B captures no audio
    const replyB = audioOutFor(audioOutput);
    await synchronizer.textOutput.captureText('REPLY_B_TEXT');
    await synchronizer.barrier();

    const playout = audioOutput.waitForPlayout();
    downstream.onPlaybackFinished({ playbackPosition: 1, interrupted: true });
    const ev = await playout;

    // the event carries A's text; B must not take it
    expect(ev.synchronizedTranscript).toContain('REPLY_A');
    expect(ownSynchronizedTranscript(ev, replyB, audioOutput)).toBeUndefined();

    await synchronizer.close();
  });

  it('keeps the transcript for a reply whose own segment was rotated out before it waited', async () => {
    const downstream = new PassthroughAudioOutput();
    const synchronizer = new TranscriptionSynchronizer(downstream, new MockTextOutput());
    const audioOutput = synchronizer.audioOutput;
    const frame = new AudioFrame(new Int16Array(160), 8000, 1, 160);

    // reply A captures its own segment
    const replyA = audioOutFor(audioOutput);
    await synchronizer.textOutput.captureText('REPLY_A_TEXT');
    synchronizer.textOutput.flush();
    await audioOutput.captureFrame(frame);
    audioOutput.flush();

    // B's text rotates A out before A's reply task starts waiting
    await synchronizer.textOutput.captureText('REPLY_B_TEXT');
    await synchronizer.barrier();

    const playout = audioOutput.waitForPlayout();
    downstream.onPlaybackFinished({ playbackPosition: 1, interrupted: true });
    const ev = await playout;

    expect(ev.synchronizedTranscript).toBeDefined();
    expect(ownSynchronizedTranscript(ev, replyA, audioOutput)).toBe(ev.synchronizedTranscript);

    await synchronizer.close();
  });

  it('returns undefined without an audio forwarding record', () => {
    const output = new PassthroughAudioOutput();
    const ev = { playbackPosition: 1, interrupted: true, synchronizedTranscript: 'text' };
    expect(ownSynchronizedTranscript(ev, null, output)).toBeUndefined();
  });
});
