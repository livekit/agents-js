// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { AudioBuffer } from '../utils.js';
import { STT, type SpeechEvent, SpeechEventType, SpeechStream } from './stt.js';

class UntimestampedSTT extends STT {
  label = 'untimestamped-stt';

  constructor() {
    super({ streaming: true, interimResults: false });
  }

  protected async _recognize(_frame: AudioBuffer): Promise<SpeechEvent> {
    return { type: SpeechEventType.FINAL_TRANSCRIPT };
  }

  stream(): SpeechStream {
    return new UntimestampedSpeechStream(this);
  }
}

class UntimestampedSpeechStream extends SpeechStream {
  label = 'untimestamped-speech-stream';

  protected async run(): Promise<void> {
    this.queue.put({ type: SpeechEventType.START_OF_SPEECH });
  }
}

describe('STT event timestamps', () => {
  it('timestamps non-streaming recognition results', async () => {
    const before = Date.now();
    const event = await new UntimestampedSTT().recognize([]);

    expect(event.createdAt).toBeGreaterThanOrEqual(before);
    expect(event.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('timestamps events before a speech stream delivers them', async () => {
    const stream = new UntimestampedSTT().stream();
    const before = Date.now();

    try {
      const { value } = await stream.next();

      expect(value?.createdAt).toBeGreaterThanOrEqual(before);
      expect(value?.createdAt).toBeLessThanOrEqual(Date.now());
    } finally {
      stream.close();
    }
  });
});
