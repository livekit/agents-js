// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { MultiInputStream } from '../stream/multi_input_stream.js';
import { AgentActivity } from './agent_activity.js';

function frameStream(value: number) {
  return new ReadableStream<AudioFrame>({
    start(controller) {
      controller.enqueue(new AudioFrame(new Int16Array([value]), 16000, 1, 1));
    },
  });
}

function fakeActivity() {
  return {
    audioStream: new MultiInputStream<AudioFrame>(),
    audioStreamId: undefined as string | undefined,
    audioRecognition: { setInputAudioStream: vi.fn() },
    realtimeSession: undefined,
    shouldDiscardInputAudio: () => false,
  };
}

const attach = (activity: ReturnType<typeof fakeActivity>, stream: ReadableStream<AudioFrame>) =>
  AgentActivity.prototype.attachAudioInput.call(activity as any, stream);

describe('AgentActivity.attachAudioInput', () => {
  it('feeds a replacement input into the stream recognition already reads', async () => {
    const activity = fakeActivity();

    attach(activity, frameStream(1));
    const recognitionInput: ReadableStream<AudioFrame> =
      activity.audioRecognition.setInputAudioStream.mock.calls[0]![0];
    const reader = recognitionInput.getReader();
    expect((await reader.read()).value!.data[0]).toBe(1);

    attach(activity, frameStream(2));

    expect(activity.audioRecognition.setInputAudioStream).toHaveBeenCalledOnce();
    expect((await reader.read()).value!.data[0]).toBe(2);
  });

  it('wires a fresh stream again after the input was detached', () => {
    const activity = fakeActivity();

    attach(activity, frameStream(1));
    AgentActivity.prototype.detachAudioInput.call(activity as any);
    attach(activity, frameStream(2));

    expect(activity.audioRecognition.setInputAudioStream).toHaveBeenCalledTimes(2);
  });
});
