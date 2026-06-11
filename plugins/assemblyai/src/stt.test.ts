// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { VAD } from '@livekit/agents-plugin-silero';
import { stt } from '@livekit/agents-plugins-test';
import { describe, expect, it } from 'vitest';
import { STT } from './stt.js';

describe('AssemblyAI options', () => {
  it('accepts u3-rt-pro-beta-1', () => {
    const stt = new STT({ apiKey: 'test-key', speechModel: 'u3-rt-pro-beta-1' });

    expect(stt.model).toBe('u3-rt-pro-beta-1');
  });

  it('accepts u3-pro parameters for u3-rt-pro-beta-1', () => {
    expect(
      () =>
        new STT({
          apiKey: 'test-key',
          speechModel: 'u3-rt-pro-beta-1',
          prompt: 'medical dictation',
          agentContext: "The agent asked for the patient's name.",
          previousContextNTurns: 10,
        }),
    ).not.toThrow();
  });

  it('requires a u3-rt-pro model for agentContext', () => {
    expect(() => new STT({ apiKey: 'test-key', agentContext: 'hello' })).toThrow(/agentContext/);
  });

  it('requires a u3-rt-pro model for previousContextNTurns', () => {
    expect(() => new STT({ apiKey: 'test-key', previousContextNTurns: 5 })).toThrow(
      /previousContextNTurns/,
    );
  });
});

const hasAssemblyAIApiKey = Boolean(process.env.ASSEMBLYAI_API_KEY);

if (hasAssemblyAIApiKey) {
  describe('AssemblyAI', async () => {
    await stt(new STT(), await VAD.load(), { nonStreaming: false });
  });
} else {
  describe('AssemblyAI', () => {
    it.skip('requires ASSEMBLYAI_API_KEY', () => {});
  });
}
