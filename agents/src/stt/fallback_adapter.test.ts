// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { AudioFrame } from '@livekit/rtc-node';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIError } from '../_exceptions.js';
import { initializeLogger } from '../log.js';
import type { APIConnectOptions } from '../types.js';
import { FallbackAdapter } from './fallback_adapter.js';
import type { STTRecognizeOptions, STTStreamOptions, SpeechEvent } from './stt.js';
import { STT, SpeechEventType, SpeechStream } from './stt.js';
import { VAD, VADEventType, type VADEvent, VADStream } from '../vad.js';

beforeAll(() => {
  initializeLogger({ level: 'silent', pretty: false });
  process.on('unhandledRejection', () => {});
});

function makeFinalTranscript(text: string): SpeechEvent {
  return {
    type: SpeechEventType.FINAL_TRANSCRIPT,
    requestId: 'test-request',
    alternatives: [
      {
        text,
        language: 'en',
        startTime: 0,
        endTime: 0,
        confidence: 1,
      },
    ],
  };
}

function makeAudioFrame(): AudioFrame {
  return new AudioFrame(new Int16Array(480), 48000, 1, 480);
}

class MockSTT extends STT {
  label: string;
  recognizeResults: Array<SpeechEvent | Error> = [];
  recognizeCalls: STTRecognizeOptions[] = [];
  streamCalls: STTStreamOptions[] = [];
  streamFactory?: (options?: STTStreamOptions) => SpeechStream;

  constructor(
    label: string,
    opts?: {
      streaming?: boolean;
      offlineRecognize?: boolean;
      recognizeResults?: Array<SpeechEvent | Error>;
      streamFactory?: (options?: STTStreamOptions) => SpeechStream;
    },
  ) {
    super({
      streaming: opts?.streaming ?? true,
      interimResults: false,
      offlineRecognize: opts?.offlineRecognize,
      alignedTranscript: false,
    });
    this.label = label;
    this.recognizeResults = opts?.recognizeResults ?? [];
    this.streamFactory = opts?.streamFactory;
  }

  protected async _recognize(
    _frame: AudioFrame | AudioFrame[],
    options?: STTRecognizeOptions,
  ): Promise<SpeechEvent> {
    this.recognizeCalls.push(options ?? {});
    const result = this.recognizeResults.shift() ?? makeFinalTranscript(`${this.label}-ok`);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }

  stream(options?: STTStreamOptions): SpeechStream {
    this.streamCalls.push(options ?? {});
    if (!this.streamFactory) {
      throw new Error(`${this.label} stream factory not configured`);
    }
    return this.streamFactory(options);
  }
}

class ImmediateFailSpeechStream extends SpeechStream {
  label = 'test.ImmediateFailSpeechStream';
  private sttInstance: STT;

  constructor(stt: STT, connOptions?: APIConnectOptions) {
    super(stt, undefined, connOptions);
    this.sttInstance = stt;
  }

  protected async run(): Promise<void> {
    const error = new APIConnectionError({ message: 'immediate fail' });
    this.sttInstance.emit('error', {
      type: 'stt_error',
      timestamp: Date.now(),
      label: this.sttInstance.label,
      error,
      recoverable: false,
    });
    throw error;
  }
}

class TranscriptSpeechStream extends SpeechStream {
  label = 'test.TranscriptSpeechStream';

  constructor(
    stt: STT,
    connOptions: APIConnectOptions | undefined,
    private text: string,
    private requireAudio = false,
  ) {
    super(stt, undefined, connOptions);
  }

  protected async run(): Promise<void> {
    let sawAudio = false;
    for await (const chunk of this.input) {
      if (chunk !== SpeechStream.FLUSH_SENTINEL) {
        sawAudio = true;
      }
    }

    if (this.requireAudio && !sawAudio) {
      throw new APIError('audio required');
    }

    this.queue.put(makeFinalTranscript(this.text));
  }
}

class BrokenPushSpeechStream extends SpeechStream {
  label = 'test.BrokenPushSpeechStream';

  constructor(stt: STT, connOptions?: APIConnectOptions) {
    super(stt, undefined, connOptions);
  }

  pushFrame(_frame: AudioFrame): void {
    throw new Error('broken recovering stream');
  }

  flush(): void {
    throw new Error('broken recovering stream');
  }

  protected async run(): Promise<void> {
    await new Promise(() => {});
  }
}

class RecoveringFailSTT extends STT {
  label = 'test.RecoveringFailSTT';
  private callCount = 0;

  constructor() {
    super({
      streaming: true,
      interimResults: false,
      offlineRecognize: false,
      alignedTranscript: false,
    });
  }

  protected async _recognize(): Promise<SpeechEvent> {
    throw new APIConnectionError({ message: 'not implemented' });
  }

  stream(options?: STTStreamOptions): SpeechStream {
    this.callCount += 1;
    if (this.callCount === 1) {
      return new ImmediateFailSpeechStream(this, options?.connOptions);
    }
    return new BrokenPushSpeechStream(this, options?.connOptions);
  }
}

class MockVAD extends VAD {
  label = 'test.MockVAD';

  constructor() {
    super({ updateInterval: 32 });
  }

  stream(): VADStream {
    return new MockVADStream(this);
  }
}

class MockVADStream extends VADStream {
  constructor(vad: VAD) {
    super(vad);
    void this.process();
  }

  private async process(): Promise<void> {
    const frames: AudioFrame[] = [];
    while (true) {
      const { done, value } = await this.inputReader.read();
      if (done) {
        break;
      }
      if (value === MockVADStream.FLUSH_SENTINEL) {
        continue;
      }
      frames.push(value);
    }

    if (frames.length > 0) {
      this.sendVADEvent(makeVadEvent(VADEventType.START_OF_SPEECH, []));
      this.sendVADEvent(makeVadEvent(VADEventType.END_OF_SPEECH, frames));
    }

    await this.outputWriter.close();
  }
}

function makeVadEvent(type: VADEventType, frames: AudioFrame[]): VADEvent {
  return {
    type,
    samplesIndex: 0,
    timestamp: Date.now(),
    speechDuration: 0,
    silenceDuration: 0,
    frames,
    probability: 1,
    inferenceDuration: 0,
    speaking: type !== VADEventType.END_OF_SPEECH,
    rawAccumulatedSilence: 0,
    rawAccumulatedSpeech: 0,
  };
}

describe('STT FallbackAdapter', () => {
  // Ref: python tests/test_stt_fallback.py - 56-146 lines
  it('uses the primary STT when recognize succeeds', async () => {
    const primary = new MockSTT('primary', {
      recognizeResults: [makeFinalTranscript('hello world')],
    });
    const fallback = new MockSTT('fallback', {
      recognizeResults: [makeFinalTranscript('fallback')],
    });
    const adapter = new FallbackAdapter({ sttInstances: [primary, fallback] });

    const event = await adapter.recognize([]);

    expect(event.alternatives?.[0]?.text).toBe('hello world');
    expect(primary.recognizeCalls).toHaveLength(1);
    expect(fallback.recognizeCalls).toHaveLength(0);

    await adapter.close();
  });

  it('falls back on recognize failure and emits availability events', async () => {
    const primary = new MockSTT('primary', {
      recognizeResults: [new APIConnectionError({ message: 'primary failed' })],
    });
    const secondary = new MockSTT('secondary', {
      recognizeResults: [makeFinalTranscript('hello world')],
    });
    const adapter = new FallbackAdapter({ sttInstances: [primary, secondary] });
    const availabilitySpy = vi.fn();
    (adapter as any).on('stt_availability_changed', availabilitySpy);

    const event = await adapter.recognize([]);

    expect(event.alternatives?.[0]?.text).toBe('hello world');
    expect(availabilitySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        stt: primary,
        available: false,
      }),
    );

    await adapter.close();
  });

  it('applies per-provider retry settings instead of using caller retry counts directly', async () => {
    const primary = new MockSTT('primary', {
      recognizeResults: [new APIConnectionError({ message: 'primary failed' })],
    });
    const secondary = new MockSTT('secondary', {
      recognizeResults: [makeFinalTranscript('secondary')],
    });
    const adapter = new FallbackAdapter({
      sttInstances: [primary, secondary],
      maxRetryPerSTT: 1,
      attemptTimeoutMs: 4321,
      retryIntervalMs: 1234,
    });

    await adapter.recognize([], {
      connOptions: {
        maxRetry: 99,
        retryIntervalMs: 9999,
        timeoutMs: 8888,
      },
    });

    expect(primary.recognizeCalls[0]?.connOptions).toEqual({
      maxRetry: 1,
      retryIntervalMs: 1234,
      timeoutMs: 4321,
    });

    await adapter.close();
  });

  it('recovers a failed recognize provider in the background', async () => {
    const primary = new MockSTT('primary', {
      recognizeResults: [
        new APIConnectionError({ message: 'primary failed' }),
        new APIConnectionError({ message: 'primary still failed' }),
        new APIConnectionError({ message: 'primary still failed again' }),
      ],
    });
    const secondary = new MockSTT('secondary', {
      recognizeResults: [
        new APIConnectionError({ message: 'secondary failed' }),
        makeFinalTranscript('secondary recovered'),
        makeFinalTranscript('secondary recovered again'),
      ],
    });
    const adapter = new FallbackAdapter({ sttInstances: [primary, secondary] });
    const recoveredPromise = new Promise<boolean>((resolve) => {
      const handler = (event: { stt: STT; available: boolean }) => {
        if (event.stt === secondary && event.available) {
          (adapter as any).off('stt_availability_changed', handler);
          resolve(true);
        }
      };
      (adapter as any).on('stt_availability_changed', handler);
    });

    await expect(adapter.recognize([])).rejects.toBeInstanceOf(APIConnectionError);
    const recovered = await recoveredPromise;

    expect(recovered).toBe(true);

    const event = await adapter.recognize([]);
    expect(event.alternatives?.[0]?.text).toBe('secondary recovered again');

    await adapter.close();
  });

  // Ref: python tests/test_stt_fallback.py - 78-114 lines
  it('falls back between streaming providers', async () => {
    const primary = new MockSTT('primary');
    const secondary = new MockSTT('secondary');
    primary.streamFactory = (options) => new ImmediateFailSpeechStream(primary, options?.connOptions);
    secondary.streamFactory = (options) =>
      new TranscriptSpeechStream(secondary, options?.connOptions, 'hello world');

    const adapter = new FallbackAdapter({ sttInstances: [primary, secondary] });
    const stream = adapter.stream();

    stream.endInput();
    const events: SpeechEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.find((event) => event.type === SpeechEventType.FINAL_TRANSCRIPT)?.alternatives?.[0]?.text).toBe(
      'hello world',
    );

    await adapter.close();
  });

  // Ref: python tests/test_stt_fallback.py - 199-238 lines
  it('does not let a broken recovering stream block the main stream', async () => {
    const secondary = new MockSTT('secondary');
    secondary.streamFactory = (options) =>
      new TranscriptSpeechStream(secondary, options?.connOptions, 'hello world', true);

    const fallback = new FallbackAdapter({
      sttInstances: [
        new RecoveringFailSTT(),
        secondary,
      ],
      maxRetryPerSTT: 0,
    });

    const audioFrame = makeAudioFrame();
    const stream = fallback.stream();
    const pushTask = (async () => {
      for (let i = 0; i < 20 && secondary.streamCalls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      stream.pushFrame(audioFrame);
      stream.endInput();
    })();

    const events: SpeechEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    await pushTask;
    expect(events.some((event) => event.alternatives?.[0]?.text === 'hello world')).toBe(true);

    await fallback.close();
  });

  it('wraps non-streaming STTs with a VAD when provided', async () => {
    const vad = new MockVAD();
    const primary = new MockSTT('non-streaming', {
      streaming: false,
      offlineRecognize: true,
      recognizeResults: [makeFinalTranscript('wrapped transcript')],
      streamFactory: () => {
        throw new Error('stream should be provided by StreamAdapter');
      },
    });
    const adapter = new FallbackAdapter({
      sttInstances: [primary],
      vad,
    });

    expect(adapter.sttInstances[0]?.capabilities.streaming).toBe(true);
    expect(adapter.sttInstances[0]?.label.startsWith('stt.StreamAdapter<')).toBe(true);

    await adapter.close();
    await vad.close();
  });
});
