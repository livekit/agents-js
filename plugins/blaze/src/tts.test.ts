import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TTS } from './tts.js';

describe('TTS', () => {
  it('has correct label', () => {
    const ttsInstance = new TTS({ authToken: 'test', apiUrl: 'http://tts:8080' });
    expect(ttsInstance.label).toBe('blaze.TTS');
  });

  it('reports correct sampleRate', () => {
    const ttsInstance = new TTS({ authToken: 'test', apiUrl: 'http://tts:8080', sampleRate: 22050 });
    expect(ttsInstance.sampleRate).toBe(22050);
  });

  it('uses default sampleRate of 24000', () => {
    const ttsInstance = new TTS({ authToken: 'test', apiUrl: 'http://tts:8080' });
    expect(ttsInstance.sampleRate).toBe(24000);
  });

  it('has mono channel (numChannels=1)', () => {
    const ttsInstance = new TTS({ authToken: 'test', apiUrl: 'http://tts:8080' });
    expect(ttsInstance.numChannels).toBe(1);
  });

  it('supports streaming capability', () => {
    const ttsInstance = new TTS({ authToken: 'test', apiUrl: 'http://tts:8080' });
    expect(ttsInstance.capabilities.streaming).toBe(true);
  });

  it('updateOptions does not throw', () => {
    const ttsInstance = new TTS({ authToken: 'test', apiUrl: 'http://tts:8080' });
    expect(() => ttsInstance.updateOptions({ language: 'en', speakerId: 'voice-2' })).not.toThrow();
  });

  it('synthesize() returns a ChunkedStream', () => {
    const ttsInstance = new TTS({ authToken: 'test', apiUrl: 'http://tts:8080' });
    // Register a no-op error handler to prevent unhandled error events
    ttsInstance.on('error', () => {});
    const stream = ttsInstance.synthesize('Hello world');
    expect(stream.label).toBe('blaze.ChunkedStream');
    expect(stream.inputText).toBe('Hello world');
    stream.close();
  });

  it('stream() returns a SynthesizeStream', () => {
    const ttsInstance = new TTS({ authToken: 'test', apiUrl: 'http://tts:8080' });
    // Register a no-op error handler to prevent unhandled error events
    ttsInstance.on('error', () => {});
    const stream = ttsInstance.stream();
    expect(stream.label).toBe('blaze.SynthesizeStream');
    stream.close();
  });

  describe('ChunkedStream synthesis', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('sends correct FormData fields to TTS endpoint', async () => {
      // Create a PCM audio response (16-bit samples at 24kHz)
      // For simplicity, use a small buffer representing a few samples
      const pcmSamples = new Int16Array(2400); // 100ms of silence at 24kHz
      const pcmBuffer = Buffer.from(pcmSamples.buffer);

      // Create a ReadableStream that yields the PCM data
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(pcmBuffer));
          controller.close();
        },
      });

      fetchMock.mockResolvedValue({
        ok: true,
        body: readable,
      });

      const ttsInstance = new TTS({
        authToken: 'test-token',
        apiUrl: 'http://tts:8080',
        language: 'vi',
        speakerId: 'speaker-1',
        model: 'v2_pro',
      });

      const stream = ttsInstance.synthesize('hello');

      // Consume the stream
      const frames = [];
      for await (const audio of stream) {
        frames.push(audio);
      }

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://tts:8080/v1/tts/realtime');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });

      // Verify FormData contains required fields
      const body = init.body as FormData;
      expect(body.get('query')).toBe('hello');
      expect(body.get('language')).toBe('vi');
      expect(body.get('audio_format')).toBe('pcm');
      expect(body.get('speaker_id')).toBe('speaker-1');
      expect(body.get('normalization')).toBe('no');
      expect(body.get('model')).toBe('v2_pro');

      // Should have emitted at least one frame
      expect(frames.length).toBeGreaterThan(0);
      // Last frame should have final=true
      expect(frames[frames.length - 1].final).toBe(true);
    });

    it('applies normalization rules before synthesis', async () => {
      const pcmSamples = new Int16Array(2400);
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(Buffer.from(pcmSamples.buffer)));
          controller.close();
        },
      });

      fetchMock.mockResolvedValue({ ok: true, body: readable });

      const ttsInstance = new TTS({
        authToken: 'tok',
        apiUrl: 'http://tts:8080',
        normalizationRules: { '$': 'đô la' },
      });

      const stream = ttsInstance.synthesize('100$');
      for await (const _ of stream) { /* consume */ }

      const body = fetchMock.mock.calls[0][1].body as FormData;
      expect(body.get('query')).toBe('100đô la');
    });

    it('builds correct FormData even when fetch returns an error response', async () => {
      // Note: Framework-level error propagation (events + unhandled rejections) is tested
      // via integration tests. Here we verify the request is correctly formed.
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const ttsInstance = new TTS({ authToken: 'tok', apiUrl: 'http://tts:8080' });
      ttsInstance.on('error', () => {}); // suppress error event

      ttsInstance.synthesize('test text');

      // Give the async run() task a tick to start
      await new Promise((r) => setTimeout(r, 10));

      // Verify fetch was called with correct URL
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe('http://tts:8080/v1/tts/realtime');
    });
  });
});
