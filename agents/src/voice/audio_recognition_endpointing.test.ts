// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ChatContext } from '../llm/chat_context.js';
import { initializeLogger } from '../log.js';
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

  override onStartOfSpeech(startedAt: number, overlapping = false): void {
    super.onStartOfSpeech(startedAt, overlapping);
    this.speechStarts.push({ startedAt, overlapping });
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
});
