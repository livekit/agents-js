// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
import { type SpeechEvent, SpeechEventType } from '../stt/stt.js';
import { AudioRecognition, type RecognitionHooks } from './audio_recognition.js';
import { BaseEndpointing } from './turn_config/endpointing.js';

function createHooks(): RecognitionHooks {
  return {
    onInterruption: () => {},
    onBackchannelConfirmed: () => {},
    onStartOfSpeech: () => {},
    onVADInferenceDone: () => {},
    onEndOfSpeech: () => {},
    onInterimTranscript: () => {},
    onFinalTranscript: () => {},
    onPreemptiveGeneration: () => {},
    onAgentBackchannelOpportunity: () => {},
    retrieveChatCtx: () => ChatContext.empty(),
    onEndOfTurn: async () => true,
  };
}

class RecordingEndpointing extends BaseEndpointing {
  speechStarts: Array<{ startedAt: number; overlapping: boolean }> = [];
  speechEnds: Array<{ endedAt: number; interruption?: boolean }> = [];

  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    super.onStartOfSpeech(startedAt, overlapping);
    this.speechStarts.push({ startedAt, overlapping });
  }

  override onEndOfSpeech(endedAt: number, interruption?: boolean): void {
    super.onEndOfSpeech(endedAt, interruption);
    this.speechEnds.push({ endedAt, interruption });
  }
}

describe('AudioRecognition endpointing integration', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('marks endpointing overlap when audio activity starts while the agent is speaking', async () => {
    const endpointing = new RecordingEndpointing({ minDelay: 300, maxDelay: 3000 });
    const recognition = new AudioRecognition({
      recognitionHooks: createHooks(),
      endpointing,
    });

    await recognition.onStartOfAgentSpeech(1000);
    await recognition.onStartOfOverlapSpeech(0, 1200);
    await recognition.onStartOfOverlapSpeech(0, 1300);

    expect(endpointing.speechStarts).toEqual([{ startedAt: 1200, overlapping: true }]);
    expect(endpointing.overlapping).toBe(true);
  });

  it.each([undefined, true, false])(
    'passes the %s interruption verdict to endpointing',
    async (interruption) => {
      const endpointing = new RecordingEndpointing({ minDelay: 300, maxDelay: 3000 });
      const recognition = new AudioRecognition({
        recognitionHooks: createHooks(),
        endpointing,
        turnDetectionMode: 'stt',
      });
      const internals = recognition as unknown as {
        speaking: boolean;
        interruptionDetected?: boolean;
        onSTTEvent: (event: SpeechEvent) => Promise<void>;
        runEOUDetection: () => void;
      };
      internals.speaking = true;
      internals.interruptionDetected = interruption;
      internals.runEOUDetection = vi.fn();
      const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);

      try {
        await internals.onSTTEvent({ type: SpeechEventType.END_OF_SPEECH });
      } finally {
        now.mockRestore();
      }

      expect(endpointing.speechEnds).toEqual([{ endedAt: 10_000, interruption }]);
    },
  );
});
