// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Transcript synchronizer pacing must ignore expressive markup.
 *
 * The synchronizer forwards the raw LLM text (markup intact — the room output strips
 * it downstream) but paces the display against the *visible* words only. Markup tags
 * carry spaces in their attributes, so the word stream shreds them into fragments
 * (`<expr`, `type="expression"`, `label="speak`, `playfully"/>`); a per-token
 * strip can't recognize those, and each fragment was paced as if it were spoken — the
 * transcript drifted seconds behind the audio on every expressive sentence.
 */
import { describe, expect, it } from 'vitest';
import { TextOutput, isTimedString } from '../io.js';
import { SegmentSynchronizerImpl, defaultTextSyncOptions } from './synchronizer.js';

// ~11 visible hyphens of speech, but dozens of hyphens of markup fragments. With the
// bug the markup alone adds many seconds of pacing; with the fix the whole transcript
// paces out in roughly the visible-word budget (~3s at the standard speech rate).
const MARKED_UP_TURN =
  '<expr type="expression" label="speak with warm surprise and bright energy"/> ' +
  'Hello there my friend! ' +
  '<expr type="sound" label="laugh"/> ' +
  '<expr type="expression" label="speak calmly and evenly, unhurried"/> ' +
  'How are you today?';

class CollectorTextOutput extends TextOutput {
  words: string[] = [];

  async captureText(text: string): Promise<void> {
    this.words.push(isTimedString(text) ? text.text : text);
  }

  flush(): void {}
}

describe('transcript synchronizer markup pacing', () => {
  it('markup fragments add no pacing delay', { timeout: 30_000 }, async () => {
    const collector = new CollectorTextOutput();
    const impl = new SegmentSynchronizerImpl({ ...defaultTextSyncOptions }, collector);
    try {
      impl.pushText(MARKED_UP_TURN);
      impl.endTextInput();
      impl.endAudioInput();

      const start = Date.now();
      impl.onPlaybackStarted(Date.now());

      // forwarding is done once the main task exhausts the word stream and the
      // capture task drains the output channel
      await (impl as unknown as { captureTask: Promise<void> }).captureTask;
      const elapsedSeconds = (Date.now() - start) / 1000;

      // every raw token is still forwarded (markup included — stripped downstream)
      expect(collector.words.join('')).toBe(MARKED_UP_TURN);

      // the pacing budget must cover only the visible words (~3s at the standard
      // speech rate); with markup fragments paced as speech it exceeds 10s
      expect(
        elapsedSeconds,
        `transcript took ${elapsedSeconds.toFixed(1)}s — markup is being paced as spoken text`,
      ).toBeLessThan(6);
    } finally {
      await impl.close();
    }
  });
});
