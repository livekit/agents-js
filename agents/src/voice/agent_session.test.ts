// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { AgentSession, resolveRecordingOptions } from './agent_session.js';
import { SpeechHandle } from './speech_handle.js';

describe('AgentSession.run', () => {
  it('forwards inputModality to generateReply', async () => {
    const session = new AgentSession();
    const generateReply = vi
      .spyOn(session, 'generateReply')
      .mockImplementation(() => SpeechHandle.create());

    session.run({ userInput: 'hello', inputModality: 'audio' });

    await vi.waitFor(() => {
      expect(generateReply).toHaveBeenCalledWith({
        userInput: 'hello',
        inputModality: 'audio',
      });
    });
  });
});

describe('resolveRecordingOptions', () => {
  it('treats a boolean as all-on or all-off', () => {
    expect(resolveRecordingOptions(true)).toEqual({
      audio: true,
      traces: true,
      logs: true,
      transcript: true,
    });
    expect(resolveRecordingOptions(false)).toEqual({
      audio: false,
      traces: false,
      logs: false,
      transcript: false,
    });
  });

  it('defaults omitted keys to true when given a partial object', () => {
    expect(resolveRecordingOptions({ audio: false })).toEqual({
      audio: false,
      traces: true,
      logs: true,
      transcript: true,
    });

    // The granular form from the docs: keep audio, drop everything else.
    expect(
      resolveRecordingOptions({ audio: true, traces: false, logs: false, transcript: false }),
    ).toEqual({
      audio: true,
      traces: false,
      logs: false,
      transcript: false,
    });
  });

  it('returns a fresh object so callers cannot corrupt the shared defaults', () => {
    const opts = resolveRecordingOptions(true);
    opts.audio = false;
    expect(resolveRecordingOptions(true).audio).toBe(true);
  });
});

describe('AgentSession recording state', () => {
  it('_enableRecording is true when any category is on and false when all are off', () => {
    const session = new AgentSession();
    // Defaults to all-off until start() resolves the record argument.
    expect(session._enableRecording).toBe(false);

    session._recordingOptions = resolveRecordingOptions({
      audio: false,
      traces: false,
      logs: true,
      transcript: false,
    });
    expect(session._enableRecording).toBe(true);

    session._recordingOptions = resolveRecordingOptions(false);
    expect(session._enableRecording).toBe(false);
  });
});
