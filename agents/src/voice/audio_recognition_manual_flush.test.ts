// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { ReadableStream } from 'node:stream/web';
import { describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../log.js';
import { FallbackAdapter } from '../stt/fallback_adapter.js';
import type { SpeechEvent, SpeechStream } from '../stt/stt.js';
import { FakeSTT } from '../stt/testing/fake_stt.js';
import { STTPipeline } from './audio_recognition.js';
import { type STTNode, sttStreamRegistration } from './io.js';

/** An STT node that registers its stream the way the default `sttNode` does, then stays open. */
function registeringNode(stt: FakeSTT, stream: SpeechStream, registered: () => void): STTNode {
  return async () => {
    sttStreamRegistration.getStore()?.register(stream, stt);
    registered();
    return new ReadableStream<SpeechEvent>();
  };
}

async function startPipeline(stt: FakeSTT, stream: SpeechStream): Promise<STTPipeline> {
  let registered!: () => void;
  const ready = new Promise<void>((resolve) => {
    registered = resolve;
  });
  const pipeline = new STTPipeline(registeringNode(stt, stream, registered));
  await ready;
  return pipeline;
}

describe('STTPipeline manual flush', () => {
  initializeLogger({ pretty: false, level: 'silent' });

  it('flushes the registered stream when the STT asks for manual flushes', async () => {
    const flush = vi.fn();
    const stt = new FakeSTT({ capabilities: { manualFlush: true } });
    const pipeline = await startPipeline(stt, { flush } as unknown as SpeechStream);
    try {
      expect(pipeline.flush()).toBe(true);
      expect(flush).toHaveBeenCalledTimes(1);
    } finally {
      await pipeline.close();
    }
  });

  it('leaves the stream alone when the STT does its own endpointing', async () => {
    const flush = vi.fn();
    const stt = new FakeSTT();
    const pipeline = await startPipeline(stt, { flush } as unknown as SpeechStream);
    try {
      expect(pipeline.flush()).toBe(false);
      expect(flush).not.toHaveBeenCalled();
    } finally {
      await pipeline.close();
    }
  });

  it('does not flush a stream that has been unregistered', async () => {
    const flush = vi.fn();
    const stream = { flush } as unknown as SpeechStream;
    const stt = new FakeSTT({ capabilities: { manualFlush: true } });
    let registered!: () => void;
    const ready = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const pipeline = new STTPipeline(async () => {
      const registration = sttStreamRegistration.getStore();
      registration?.register(stream, stt);
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

  it('treats a stream that rejects the flush as not flushed', async () => {
    const flush = vi.fn(() => {
      throw new Error('stream closed');
    });
    const stt = new FakeSTT({ capabilities: { manualFlush: true } });
    const pipeline = await startPipeline(stt, { flush } as unknown as SpeechStream);
    try {
      expect(pipeline.flush()).toBe(false);
    } finally {
      await pipeline.close();
    }
  });
});

describe('FallbackAdapter manual flush', () => {
  initializeLogger({ pretty: false, level: 'silent' });

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
