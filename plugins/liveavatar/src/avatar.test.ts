// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarSession } from './avatar.js';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./log.js', () => ({ log: () => logger }));

class FakeAudioBuffer {
  started = 0;
  finished: [number, boolean][] = [];

  notifyPlaybackStarted(): void {
    this.started += 1;
  }

  notifyPlaybackFinished(playbackPosition: number, interrupted: boolean): void {
    this.finished.push([playbackPosition, interrupted]);
  }
}

type AvatarSessionInternals = {
  audioBuffer: FakeAudioBuffer;
  audioPlaying: boolean;
  avatarInterrupted: boolean;
  avatarSpeaking: boolean;
  handleServerEvent(event: Record<string, unknown>): void;
  onClearBuffer(event: { wasCapturing: boolean }): void;
  playbackPosition: number;
  sessionConnectedFuture: { done: boolean };
};

function createAvatar(): [AvatarSession, AvatarSessionInternals, FakeAudioBuffer] {
  const session = new AvatarSession({ apiKey: 'test-key', avatarId: 'av-1' });
  const internals = session as unknown as AvatarSessionInternals;
  const buffer = new FakeAudioBuffer();
  internals.audioBuffer = buffer;
  return [session, internals, buffer];
}

describe('LiveAvatar WebSocket event dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('still unblocks forwarding when the session connects', () => {
    const [, avatar] = createAvatar();
    expect(avatar.sessionConnectedFuture.done).toBe(false);
    avatar.handleServerEvent({ type: 'session.state_updated', state: 'connected' });
    expect(avatar.sessionConnectedFuture.done).toBe(true);
  });

  it('marks speaking and starts playback on agent.state_updated talking', () => {
    const [, avatar, buffer] = createAvatar();
    avatar.handleServerEvent({
      type: 'agent.state_updated',
      previous_state: 'listening',
      new_state: 'talking',
    });
    expect(avatar.avatarSpeaking).toBe(true);
    expect(buffer.started).toBe(1);
    expect(buffer.finished).toEqual([]);
  });

  it('finishes playback on agent.state_updated listening', () => {
    const [, avatar, buffer] = createAvatar();
    avatar.playbackPosition = 1.25;
    avatar.handleServerEvent({
      type: 'agent.state_updated',
      previous_state: 'idle',
      new_state: 'talking',
    });
    avatar.handleServerEvent({
      type: 'agent.state_updated',
      previous_state: 'talking',
      new_state: 'listening',
    });
    expect(avatar.avatarSpeaking).toBe(false);
    expect(buffer.started).toBe(1);
    expect(buffer.finished).toEqual([[1.25, false]]);
  });

  it('does not drive speaking state from buffer acknowledgements', () => {
    const [, avatar, buffer] = createAvatar();
    avatar.handleServerEvent({ type: 'agent.audio_buffer_appended' });
    avatar.handleServerEvent({ type: 'agent.audio_buffer_committed' });
    expect(avatar.avatarSpeaking).toBe(false);
    expect(buffer.started).toBe(0);
    expect(buffer.finished).toEqual([]);
  });

  it('handles speak_started and talking idempotently', () => {
    const [, avatar, buffer] = createAvatar();
    avatar.handleServerEvent({ type: 'agent.speak_started' });
    avatar.handleServerEvent({
      type: 'agent.state_updated',
      previous_state: 'idle',
      new_state: 'talking',
    });
    expect(avatar.avatarSpeaking).toBe(true);
    expect(buffer.started).toBe(1);
  });

  it('marks playback interrupted when the audio buffer is cleared', () => {
    const [, avatar, buffer] = createAvatar();
    avatar.handleServerEvent({
      type: 'agent.state_updated',
      previous_state: 'idle',
      new_state: 'talking',
    });
    avatar.handleServerEvent({ type: 'agent.audio_buffer_cleared' });
    avatar.handleServerEvent({
      type: 'agent.state_updated',
      previous_state: 'talking',
      new_state: 'idle',
    });
    expect(avatar.avatarInterrupted).toBe(true);
    expect(avatar.avatarSpeaking).toBe(false);
    expect(buffer.finished).toEqual([]);
  });

  it('keeps the interrupted latch across a redundant talking event', () => {
    const [, avatar, buffer] = createAvatar();
    avatar.playbackPosition = 2.5;
    avatar.handleServerEvent({
      type: 'agent.state_updated',
      previous_state: 'idle',
      new_state: 'talking',
    });
    avatar.handleServerEvent({ type: 'agent.audio_buffer_cleared' });
    // A duplicate start for the same turn must not clear the latch, or the
    // following speak end would report a second, non-interrupted playback.
    avatar.handleServerEvent({
      type: 'agent.state_updated',
      previous_state: 'talking',
      new_state: 'talking',
    });
    expect(avatar.avatarInterrupted).toBe(true);
    avatar.handleServerEvent({
      type: 'agent.state_updated',
      previous_state: 'talking',
      new_state: 'idle',
    });
    expect(avatar.avatarSpeaking).toBe(false);
    expect(buffer.started).toBe(1);
    expect(buffer.finished).toEqual([]);
  });

  it('logs error events at error level', () => {
    const [, avatar, buffer] = createAvatar();
    const error = { type: 'invalid_request_error', message: 'bad audio' };
    avatar.handleServerEvent({ type: 'error', error });
    expect(logger.error).toHaveBeenCalledWith({ error }, 'LiveAvatar error');
    expect(avatar.avatarSpeaking).toBe(false);
    expect(buffer.started).toBe(0);
  });

  it('sends an interrupt on barge-in after talking', () => {
    const [session, avatar] = createAvatar();
    avatar.handleServerEvent({
      type: 'agent.state_updated',
      previous_state: 'idle',
      new_state: 'talking',
    });
    avatar.audioPlaying = true;
    const sendEvent = vi.spyOn(session, 'sendEvent');
    avatar.onClearBuffer({ wasCapturing: true });
    expect(sendEvent).toHaveBeenCalledWith({
      type: 'agent.interrupt',
      event_id: expect.any(String),
    });
  });

  it('skips the interrupt on barge-in when never talking', () => {
    const [session, avatar] = createAvatar();
    avatar.handleServerEvent({ type: 'agent.audio_buffer_appended' });
    avatar.audioPlaying = true;
    const sendEvent = vi.spyOn(session, 'sendEvent');
    avatar.onClearBuffer({ wasCapturing: true });
    expect(sendEvent).not.toHaveBeenCalled();
  });
});
