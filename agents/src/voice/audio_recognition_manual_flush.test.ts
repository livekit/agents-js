// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { FallbackAdapter } from '../stt/fallback_adapter.js';
import { type SpeechEvent, type SpeechStream, _FLUSH_MARKER } from '../stt/stt.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { STTPipeline } from './audio_recognition.js';
import { sttStreamRegistration } from './io.js';

initializeLogger({ pretty: false, level: 'silent' });

function makeFrame(): AudioFrame {
  return new AudioFrame(new Int16Array(160), 16000, 1, 160);
}

/**
 * Starts a pipeline whose node registers `stream` and records the audio it reads. With
 * `unwrapped`, the node registers the audio it was given, like the default node; otherwise it
 * registers other audio, like a custom node that wraps it.
 */
async function startPipeline(stt: FakeSTT, stream: SpeechStream, unwrapped: boolean) {
  const received: unknown[] = [];
  let registered!: () => void;
  const ready = new Promise<void>((resolve) => {
    registered = resolve;
  });
  const pipeline = new STTPipeline(async (audio) => {
    const input = audio as ReadableStream<AudioFrame>;
    sttStreamRegistration
      .getStore()
      ?.register(stream, stt, unwrapped ? input : new ReadableStream<AudioFrame>());
    registered();
    void (async () => {
      for await (const item of input) received.push(item);
    })().catch(() => {});
    return new ReadableStream<SpeechEvent>();
  });
  await ready;
  return { pipeline, received };
}

describe('STTPipeline manual flush', () => {
  it('sends the flush with the audio to a stream fed the unwrapped audio', async () => {
    const flush = vi.fn();
    const stt = new FakeSTT({ capabilities: { manualFlush: true } });
    const { pipeline, received } = await startPipeline(
      stt,
      { flush } as unknown as SpeechStream,
      true,
    );
    try {
      const [first, second] = [makeFrame(), makeFrame()];
      await pipeline.audioChannel.write(first);
      expect(pipeline.flush()).toBe(true);
      await pipeline.audioChannel.write(second);
      await vi.waitFor(() => expect(received).toEqual([first, _FLUSH_MARKER, second]));
      expect(flush).not.toHaveBeenCalled();
    } finally {
      await pipeline.close();
    }
  });

  it('flushes the stream directly when a custom node wraps the audio', async () => {
    const flush = vi.fn();
    const stt = new FakeSTT({ capabilities: { manualFlush: true } });
    const { pipeline, received } = await startPipeline(
      stt,
      { flush } as unknown as SpeechStream,
      false,
    );
    try {
      const [first, second] = [makeFrame(), makeFrame()];
      await pipeline.audioChannel.write(first);
      expect(pipeline.flush()).toBe(true);
      await pipeline.audioChannel.write(second);
      // the custom node never sees the marker
      await vi.waitFor(() => expect(received).toEqual([first, second]));
      expect(flush).toHaveBeenCalledOnce();
    } finally {
      await pipeline.close();
    }
  });

  it('leaves the stream alone when the STT does its own endpointing', async () => {
    const flush = vi.fn();
    const { pipeline, received } = await startPipeline(
      new FakeSTT(),
      { flush } as unknown as SpeechStream,
      true,
    );
    try {
      const frame = makeFrame();
      expect(pipeline.flush()).toBe(false);
      await pipeline.audioChannel.write(frame);
      await vi.waitFor(() => expect(received).toEqual([frame]));
      expect(flush).not.toHaveBeenCalled();
    } finally {
      await pipeline.close();
    }
  });

  it('does not flush once the stream is unregistered', async () => {
    const flush = vi.fn();
    const stream = { flush } as unknown as SpeechStream;
    const stt = new FakeSTT({ capabilities: { manualFlush: true } });
    let registered!: () => void;
    const ready = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const pipeline = new STTPipeline(async (audio) => {
      const registration = sttStreamRegistration.getStore();
      registration?.register(stream, stt, audio as ReadableStream<AudioFrame>);
      registration?.unregister(stream);
      registered();
      return new ReadableStream<SpeechEvent>();
    });
    await ready;
    try {
      expect(pipeline.flush()).toBe(false);
      expect(flush).not.toHaveBeenCalled();
    } finally {
      await pipeline.close();
    }
  });

  it('keeps forwarding audio when the stream rejects the flush', async () => {
    const flush = vi.fn(() => {
      throw new Error('stream closed');
    });
    const stt = new FakeSTT({ capabilities: { manualFlush: true } });
    const { pipeline, received } = await startPipeline(
      stt,
      { flush } as unknown as SpeechStream,
      false,
    );
    try {
      const frame = makeFrame();
      expect(pipeline.flush()).toBe(true);
      await pipeline.audioChannel.write(frame);
      await vi.waitFor(() => expect(received).toEqual([frame]));
      expect(flush).toHaveBeenCalledOnce();
    } finally {
      await pipeline.close();
    }
  });
});

describe('FallbackAdapter manual flush', () => {
  it('asks for manual flushes only when every instance does', () => {
    const manual = () => new FakeSTT({ capabilities: { manualFlush: true } });

    expect(
      new FallbackAdapter({ sttInstances: [manual(), manual()] }).capabilities.manualFlush,
    ).toBe(true);
    expect(
      new FallbackAdapter({ sttInstances: [manual(), new FakeSTT()] }).capabilities.manualFlush,
    ).toBe(false);
  });

  it('follows a wrapped instance whose capability changes', () => {
    const changing = new FakeSTT({ capabilities: { manualFlush: true } });
    const adapter = new FallbackAdapter({ sttInstances: [changing] });
    expect(adapter.capabilities.manualFlush).toBe(true);

    changing.capabilities.manualFlush = false;
    expect(adapter.capabilities.manualFlush).toBe(false);
  });
});
