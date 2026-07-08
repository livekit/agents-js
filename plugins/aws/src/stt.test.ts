// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type { TranscribeStreamingClient } from '@aws-sdk/client-transcribe-streaming';
import { APIError, APIStatusError, stt } from '@livekit/agents';
import { VAD } from '@livekit/agents-plugin-silero';
import { stt as sttTest } from '@livekit/agents-plugins-test';
import { AudioFrame } from '@livekit/rtc-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STT } from './stt.js';
import type { STTOptions } from './stt.js';

// Failure-path tests drive SpeechStream.mainTask, which re-throws after
// emitting the STT 'error' event (the rethrow only drives `.finally()` cleanup).
// That produces a by-design floating rejection; swallow expected API errors.
const swallowExpectedRejection = (reason: unknown) => {
  if (reason instanceof APIError) return;
  throw reason;
};
beforeAll(() => process.on('unhandledRejection', swallowExpectedRejection));
afterAll(() => void process.off('unhandledRejection', swallowExpectedRejection));

const hasAwsCredentials = Boolean(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);

const baseOpts: Partial<STTOptions> = { sampleRate: 16000, language: 'en-US' };

function fakeClient(
  sessions: Array<() => AsyncGenerator<Record<string, unknown>>>,
): TranscribeStreamingClient {
  let call = 0;
  return {
    send: async () => {
      const session = sessions[Math.min(call, sessions.length - 1)]!;
      call += 1;
      return { TranscriptResultStream: session() };
    },
  } as unknown as TranscribeStreamingClient;
}

function transcriptEvent(...results: Record<string, unknown>[]) {
  return { TranscriptEvent: { Transcript: { Results: results } } };
}

// Exercises the public STT constructor + STT.stream(), rather than instantiating the
// internal SpeechStream class directly, so these tests also cover STT.stream()'s wiring.
function stream(client: TranscribeStreamingClient) {
  return new STT({ ...baseOpts, client }).stream();
}

describe('AWS Transcribe STT - constructor', () => {
  it('throws when identifyLanguage and identifyMultipleLanguages are both set', () => {
    expect(() => new STT({ identifyLanguage: true, identifyMultipleLanguages: true })).toThrow(
      /mutually exclusive/,
    );
  });

  it('throws when identifyLanguage is set without languageOptions', () => {
    expect(() => new STT({ identifyLanguage: true })).toThrow(/languageOptions is required/);
  });

  it('throws when identifyMultipleLanguages is set without languageOptions', () => {
    expect(() => new STT({ identifyMultipleLanguages: true })).toThrow(
      /languageOptions is required/,
    );
  });

  it('accepts identifyLanguage when languageOptions is provided', () => {
    expect(() => new STT({ identifyLanguage: true, languageOptions: 'en-US,es-US' })).not.toThrow();
  });

  it('defaults numberOfChannels to 2 when enableChannelIdentification is set', () => {
    expect(() => new STT({ enableChannelIdentification: true })).not.toThrow();
  });

  it('throws when numberOfChannels is set without enableChannelIdentification', () => {
    expect(() => new STT({ numberOfChannels: 2 })).toThrow(
      /numberOfChannels requires enableChannelIdentification/,
    );
  });

  it('throws when enableChannelIdentification is set with a numberOfChannels other than 2', () => {
    expect(() => new STT({ enableChannelIdentification: true, numberOfChannels: 1 })).toThrow(
      /numberOfChannels must be 2/,
    );
  });

  it('reports streaming-only capabilities with word-aligned transcripts', () => {
    const sttInstance = new STT();
    expect(sttInstance.capabilities).toEqual({
      streaming: true,
      interimResults: true,
      alignedTranscript: 'word',
    });
  });

  it('reports the provider label', () => {
    const sttInstance = new STT();
    expect(sttInstance.provider).toBe('Amazon Transcribe');
    expect(sttInstance.label).toBe('aws.STT');
  });

  it('defaults model to "unknown" without a languageModelName', () => {
    expect(new STT().model).toBe('unknown');
  });

  it('reports languageModelName as the model when provided', () => {
    expect(new STT({ languageModelName: 'my-custom-model' }).model).toBe('my-custom-model');
  });

  it('rejects single-frame recognition', async () => {
    const sttInstance = new STT();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((sttInstance as any)._recognize()).rejects.toThrow(
      /does not support single-frame recognition/,
    );
  });
});

describe('AWS Transcribe STT - SpeechStream event mapping', () => {
  it('maps START_OF_SPEECH / FINAL_TRANSCRIPT / END_OF_SPEECH from a TranscriptEvent', async () => {
    const client = fakeClient([
      async function* () {
        yield transcriptEvent({
          StartTime: 0,
          EndTime: 0.5,
          IsPartial: false,
          Alternatives: [
            {
              Transcript: 'hello.',
              Items: [
                {
                  Content: 'hello',
                  Type: 'pronunciation',
                  StartTime: 0,
                  EndTime: 0.4,
                  Confidence: 0.9,
                },
                { Content: '.', Type: 'punctuation' },
              ],
            },
          ],
        });
      },
    ]);

    const speechStream = stream(client);

    const events: Awaited<ReturnType<typeof speechStream.next>>['value'][] = [];
    const collect = (async () => {
      for await (const event of speechStream) {
        events.push(event);
      }
    })();

    speechStream.endInput();
    await collect;

    expect(events.map((e) => e.type)).toEqual([
      stt.SpeechEventType.START_OF_SPEECH,
      stt.SpeechEventType.FINAL_TRANSCRIPT,
      stt.SpeechEventType.END_OF_SPEECH,
    ]);
    expect(events[1]?.alternatives?.[0]?.text).toBe('hello.');
    // The punctuation item is excluded from words and from the confidence average.
    expect(events[1]?.alternatives?.[0]?.words).toHaveLength(1);
    expect(events[1]?.alternatives?.[0]?.words?.[0]?.text).toBe('hello');
    expect(events[1]?.alternatives?.[0]?.confidence).toBe(0.9);
  });

  it('surfaces Transcribe speaker labels on words and the segment', async () => {
    const client = fakeClient([
      async function* () {
        yield transcriptEvent({
          StartTime: 0,
          EndTime: 0.8,
          IsPartial: false,
          Alternatives: [
            {
              Transcript: 'hello world',
              Items: [
                {
                  Content: 'hello',
                  Type: 'pronunciation',
                  StartTime: 0,
                  EndTime: 0.3,
                  Confidence: 0.95,
                  Speaker: 'spk_0',
                },
                {
                  Content: 'world',
                  Type: 'pronunciation',
                  StartTime: 0.4,
                  EndTime: 0.8,
                  Confidence: 0.9,
                  Speaker: 'spk_0',
                },
              ],
            },
          ],
        });
      },
    ]);

    const speechStream = stream(client);

    const events: Awaited<ReturnType<typeof speechStream.next>>['value'][] = [];
    const collect = (async () => {
      for await (const event of speechStream) {
        events.push(event);
      }
    })();

    speechStream.endInput();
    await collect;

    const alt = events.find((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT)
      ?.alternatives?.[0];
    expect(alt?.speakerId).toBe('spk_0');
    expect(alt?.words?.map((w) => w.speakerId)).toEqual(['spk_0', 'spk_0']);
  });

  it('emits START_OF_SPEECH for every utterance, not just the first in the session', async () => {
    const client = fakeClient([
      async function* () {
        yield transcriptEvent({
          StartTime: 0,
          EndTime: 0.5,
          IsPartial: false,
          Alternatives: [{ Transcript: 'first', Items: [] }],
        });
        // A later utterance in the same session never has StartTime === 0.
        yield transcriptEvent({
          StartTime: 3.2,
          EndTime: 3.8,
          IsPartial: false,
          Alternatives: [{ Transcript: 'second', Items: [] }],
        });
      },
    ]);

    const speechStream = stream(client);

    const events: Awaited<ReturnType<typeof speechStream.next>>['value'][] = [];
    const collect = (async () => {
      for await (const event of speechStream) {
        events.push(event);
      }
    })();

    speechStream.endInput();
    await collect;

    expect(events.filter((e) => e.type === stt.SpeechEventType.START_OF_SPEECH)).toHaveLength(2);
    expect(events.filter((e) => e.type === stt.SpeechEventType.END_OF_SPEECH)).toHaveLength(2);
  });

  it('tracks speaking state independently per channel within a single TranscriptEvent', async () => {
    const client = fakeClient([
      async function* () {
        // Both channels start together...
        yield transcriptEvent(
          { ChannelId: 'ch_0', StartTime: 0, EndTime: 0.3, IsPartial: true, Alternatives: [] },
          { ChannelId: 'ch_1', StartTime: 0, EndTime: 0.3, IsPartial: true, Alternatives: [] },
        );
        // ...channel 0 finishes while channel 1 is still mid-utterance, in the same event.
        // Channel 0 finishing must not spuriously re-trigger START_OF_SPEECH for channel 1.
        yield transcriptEvent(
          {
            ChannelId: 'ch_0',
            StartTime: 0,
            EndTime: 0.5,
            IsPartial: false,
            Alternatives: [{ Transcript: 'done', Items: [] }],
          },
          {
            ChannelId: 'ch_1',
            StartTime: 0,
            EndTime: 0.6,
            IsPartial: true,
            Alternatives: [{ Transcript: 'still going', Items: [] }],
          },
        );
      },
    ]);

    const speechStream = stream(client);

    const events: Awaited<ReturnType<typeof speechStream.next>>['value'][] = [];
    const collect = (async () => {
      for await (const event of speechStream) {
        events.push(event);
      }
    })();

    speechStream.endInput();
    await collect;

    // One START_OF_SPEECH per channel (not one per result), and exactly one END_OF_SPEECH
    // for the channel that actually finished.
    expect(events.filter((e) => e.type === stt.SpeechEventType.START_OF_SPEECH)).toHaveLength(2);
    expect(events.filter((e) => e.type === stt.SpeechEventType.END_OF_SPEECH)).toHaveLength(1);
  });

  it('does not drop a final transcript whose EndTime is exactly 0', async () => {
    const client = fakeClient([
      async function* () {
        yield transcriptEvent({
          StartTime: 0,
          EndTime: 0,
          IsPartial: false,
          Alternatives: [{ Transcript: 'ok', Items: [] }],
        });
      },
    ]);

    const speechStream = stream(client);

    const events: Awaited<ReturnType<typeof speechStream.next>>['value'][] = [];
    const collect = (async () => {
      for await (const event of speechStream) {
        events.push(event);
      }
    })();

    speechStream.endInput();
    await collect;

    expect(events.some((e) => e.alternatives?.[0]?.text === 'ok')).toBe(true);
  });

  it('reconnects silently on an idle timeout instead of surfacing an error', async () => {
    let firstSessionStarted = false;
    const client = fakeClient([
      async function* () {
        firstSessionStarted = true;
        const err = new Error('Your request timed out waiting for input');
        err.name = 'BadRequestException';
        throw err;
      },
      async function* () {
        yield transcriptEvent({
          StartTime: 0,
          EndTime: 0.2,
          IsPartial: false,
          Alternatives: [{ Transcript: 'hi', Items: [] }],
        });
      },
    ]);

    const speechStream = stream(client);

    const events: Awaited<ReturnType<typeof speechStream.next>>['value'][] = [];
    const collect = (async () => {
      for await (const event of speechStream) {
        events.push(event);
      }
    })();

    speechStream.endInput();
    await collect;

    expect(firstSessionStarted).toBe(true);
    expect(events.some((e) => e.alternatives?.[0]?.text === 'hi')).toBe(true);
  });

  it('resets speaking state on an idle-timeout reconnect so START_OF_SPEECH re-fires', async () => {
    const client = fakeClient([
      async function* () {
        // A partial result mid-utterance leaves speaking state true when the idle timeout hits.
        yield transcriptEvent({
          StartTime: 1,
          EndTime: 1.5,
          IsPartial: true,
          Alternatives: [{ Transcript: 'partial', Items: [] }],
        });
        const err = new Error('Your request timed out waiting for input');
        err.name = 'BadRequestException';
        throw err;
      },
      async function* () {
        yield transcriptEvent({
          StartTime: 0.3,
          EndTime: 0.6,
          IsPartial: false,
          Alternatives: [{ Transcript: 'resumed', Items: [] }],
        });
      },
    ]);

    const speechStream = stream(client);

    const events: Awaited<ReturnType<typeof speechStream.next>>['value'][] = [];
    const collect = (async () => {
      for await (const event of speechStream) {
        events.push(event);
      }
    })();

    speechStream.endInput();
    await collect;

    expect(events.filter((e) => e.type === stt.SpeechEventType.START_OF_SPEECH)).toHaveLength(2);
  });

  it('keeps word/segment timestamps monotonic across an idle-timeout reconnect', async () => {
    const client = fakeClient([
      async function* () {
        yield transcriptEvent({
          StartTime: 20,
          EndTime: 20.5,
          IsPartial: false,
          Alternatives: [{ Transcript: 'first', Items: [] }],
        });
        const err = new Error('Your request timed out waiting for input');
        err.name = 'BadRequestException';
        throw err;
      },
      async function* () {
        // The new connection's raw clock resets to ~0.
        yield transcriptEvent({
          StartTime: 0.3,
          EndTime: 0.6,
          IsPartial: false,
          Alternatives: [{ Transcript: 'second', Items: [] }],
        });
      },
    ]);

    const speechStream = stream(client);

    const events: Awaited<ReturnType<typeof speechStream.next>>['value'][] = [];
    const collect = (async () => {
      for await (const event of speechStream) {
        events.push(event);
      }
    })();

    speechStream.endInput();
    await collect;

    const finals = events.filter((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT);
    expect(finals).toHaveLength(2);
    const firstEnd = finals[0]?.alternatives?.[0]?.endTime ?? -Infinity;
    const secondStart = finals[1]?.alternatives?.[0]?.startTime ?? -Infinity;
    expect(secondStart).toBeGreaterThanOrEqual(firstEnd);
  });

  it('surfaces a BadRequestException stream event as a non-retryable APIStatusError', async () => {
    const client = fakeClient([
      async function* () {
        yield { BadRequestException: { Message: 'Invalid sample rate' } };
      },
    ]);

    const sttInstance = new STT({ ...baseOpts, client });
    // Fatal errors surface on the STT instance, not through the event iterator.
    const errorEvent = new Promise<{ error: Error; recoverable: boolean }>((resolve) => {
      sttInstance.on('error', (event) => resolve(event));
    });

    const speechStream = sttInstance.stream({
      connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 1000 },
    });
    const drain = (async () => {
      for await (const _event of speechStream) {
        // discard
      }
    })();

    speechStream.endInput();

    const { error, recoverable } = await errorEvent;
    expect(error).toBeInstanceOf(APIStatusError);
    const statusError = error as APIStatusError;
    expect(statusError.statusCode).toBe(400);
    expect(statusError.retryable).toBe(false);
    expect(statusError.message).toMatch(/Invalid sample rate/);
    expect(recoverable).toBe(false);

    await drain.catch(() => {});
  });

  it('reconnects when idle timeout arrives as a BadRequestException stream event', async () => {
    const client = fakeClient([
      async function* () {
        yield {
          BadRequestException: { Message: 'Your request timed out waiting for input' },
        };
      },
      async function* () {
        yield transcriptEvent({
          StartTime: 0,
          EndTime: 0.2,
          IsPartial: false,
          Alternatives: [{ Transcript: 'hi', Items: [] }],
        });
      },
    ]);

    const speechStream = stream(client);

    const events: Awaited<ReturnType<typeof speechStream.next>>['value'][] = [];
    const collect = (async () => {
      for await (const event of speechStream) {
        events.push(event);
      }
    })();

    speechStream.endInput();
    await collect;

    expect(events.some((e) => e.alternatives?.[0]?.text === 'hi')).toBe(true);
  });

  it('classifies a non-idle-timeout failure as a hard failure the base class retries', async () => {
    // The base SpeechStream intentionally stays silent on the 'error' event for recoverable
    // retries (only terminal failures emit), so success-after-retry is observed via the
    // recovered transcript rather than an event.
    let attempts = 0;
    const client = {
      send: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('access denied');
        }
        return {
          TranscriptResultStream: (async function* () {
            yield transcriptEvent({
              StartTime: 0,
              EndTime: 0.2,
              IsPartial: false,
              Alternatives: [{ Transcript: 'recovered', Items: [] }],
            });
          })(),
        };
      },
    } as unknown as TranscribeStreamingClient;

    const speechStream = new STT({ ...baseOpts, client }).stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 },
    });

    const events: Awaited<ReturnType<typeof speechStream.next>>['value'][] = [];
    const collect = (async () => {
      for await (const event of speechStream) {
        events.push(event);
      }
    })();

    speechStream.endInput();
    await collect;

    expect(attempts).toBe(2);
    expect(events.some((e) => e.alternatives?.[0]?.text === 'recovered')).toBe(true);
  });

  it('resets speaking state across a hard-failure retry so START_OF_SPEECH re-fires', async () => {
    let attempts = 0;
    const client = {
      send: async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            TranscriptResultStream: (async function* () {
              // Mid-utterance (partial, speaking state left true) when the hard failure hits.
              yield transcriptEvent({
                StartTime: 1,
                EndTime: 1.5,
                IsPartial: true,
                Alternatives: [{ Transcript: 'partial', Items: [] }],
              });
              throw new Error('connection reset');
            })(),
          };
        }
        return {
          TranscriptResultStream: (async function* () {
            yield transcriptEvent({
              StartTime: 0.3,
              EndTime: 0.6,
              IsPartial: false,
              Alternatives: [{ Transcript: 'resumed', Items: [] }],
            });
          })(),
        };
      },
    } as unknown as TranscribeStreamingClient;

    const speechStream = new STT({ ...baseOpts, client }).stream({
      connOptions: { maxRetry: 1, retryIntervalMs: 1, timeoutMs: 1000 },
    });

    const events: Awaited<ReturnType<typeof speechStream.next>>['value'][] = [];
    const collect = (async () => {
      for await (const event of speechStream) {
        events.push(event);
      }
    })();

    speechStream.endInput();
    await collect;

    expect(attempts).toBe(2);
    expect(events.filter((e) => e.type === stt.SpeechEventType.START_OF_SPEECH)).toHaveLength(2);
    const finals = events.filter((e) => e.type === stt.SpeechEventType.FINAL_TRANSCRIPT);
    expect(finals).toHaveLength(1);
    // The retried session's raw StartTime (0.3) must be pushed past the failed session's
    // furthest known point (1.5), not reported as an earlier absolute timestamp.
    expect(finals[0]?.alternatives?.[0]?.startTime ?? -Infinity).toBeGreaterThanOrEqual(1.5);
  });

  it('does not lose or duplicate audio frames across an idle-timeout reconnect', async () => {
    // Regression test: SpeechStream must own a single pump over `this.input` and hand each
    // session a token-guarded generator over a persistent channel — never let an abandoned
    // session keep consuming frames meant for the reconnected session (see the #channel field
    // comment in stt.ts).
    const receivedChunks: Uint8Array[] = [];
    let call = 0;

    const client = {
      send: async (command: {
        input: { AudioStream: AsyncIterable<{ AudioEvent?: { AudioChunk?: Uint8Array } }> };
      }) => {
        call += 1;
        if (call === 1) {
          // The idle timeout fires on the response side without ever draining the
          // request-side AudioStream, mirroring how AWS reports it in practice.
          return {
            TranscriptResultStream: (async function* () {
              const err = new Error('Your request timed out waiting for input');
              err.name = 'BadRequestException';
              throw err;
            })(),
          };
        }

        // Second session: actually drain AudioStream so we can prove every frame
        // pushed around the reconnect reaches this session exactly once.
        for await (const event of command.input.AudioStream) {
          const chunk = event.AudioEvent?.AudioChunk;
          if (chunk) receivedChunks.push(chunk);
        }

        return {
          TranscriptResultStream: (async function* () {
            yield transcriptEvent({
              StartTime: 0,
              EndTime: 0.2,
              IsPartial: false,
              Alternatives: [{ Transcript: 'ok', Items: [] }],
            });
          })(),
        };
      },
    } as unknown as TranscribeStreamingClient;

    const speechStream = stream(client);

    const events: Awaited<ReturnType<typeof speechStream.next>>['value'][] = [];
    const collect = (async () => {
      for await (const event of speechStream) {
        events.push(event);
      }
    })();

    speechStream.pushFrame(new AudioFrame(new Int16Array([1, 2, 3, 4]), 16000, 1, 4));
    speechStream.endInput();

    await collect;

    expect(call).toBe(2);
    // 1 pushed frame (8 bytes) + the terminal empty chunk, each exactly once — no loss,
    // no duplication, and nothing delivered to the abandoned first session.
    expect(receivedChunks).toHaveLength(2);
    expect(receivedChunks.reduce((sum, c) => sum + c.length, 0)).toBe(8);
    expect(receivedChunks.some((c) => c.length === 0)).toBe(true);
    expect(events.some((e) => e.alternatives?.[0]?.text === 'ok')).toBe(true);
  });
});

describe('AWS Transcribe STT (live)', () => {
  if (hasAwsCredentials) {
    it('passes the shared STT test harness', { timeout: 30_000 }, async () => {
      await sttTest(new STT(), await VAD.load(), { streaming: true, nonStreaming: false });
    });
  } else {
    it.skip('requires AWS_ACCESS_KEY_ID or AWS_PROFILE', () => {});
  }
});
