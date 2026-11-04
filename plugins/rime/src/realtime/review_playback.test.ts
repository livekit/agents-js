// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger, voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { expect, it } from 'vitest';
import { RealtimeModel } from './realtime_model.js';

initializeLogger({ pretty: false, level: 'silent' });
class ControlledOutput extends voice.AudioOutput {
  constructor() {
    super(24000);
  }
  override clearBuffer(): void {
    super.flush();
    this.onPlaybackFinished({ playbackPosition: 0, interrupted: true });
  }
  finish(): void {
    this.onPlaybackFinished({ playbackPosition: 0.1, interrupted: false });
  }
}

it('waits for the next playback segment after clearing an open segment', async () => {
  const model = new RealtimeModel({ apiKey: 'test' });
  const sink = new ControlledOutput();
  const output = model.wrapAudioOutput(sink);
  const frame = new AudioFrame(new Int16Array(2400), 24000, 1, 2400);
  try {
    await output.captureFrame(frame);
    output.clearBuffer();
    expect((await output.waitForPlayout()).interrupted).toBe(true);
    await output.captureFrame(frame);
    output.flush();
    let completed = false;
    const pending = output.waitForPlayout().then((event) => {
      completed = true;
      return event;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    sink.finish();
    expect((await pending).interrupted).toBe(false);
  } finally {
    await model.close();
  }
});
