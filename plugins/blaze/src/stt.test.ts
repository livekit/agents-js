// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STT } from './stt.js';

type AnyFn = (...args: unknown[]) => unknown;
type STTWithRecognize = STT & { _recognize: AnyFn };

/** Create a minimal PCM frame mock. */
function makePcmFrame(samples = 160, sampleRate = 16000, channels = 1) {
  return {
    data: new Int16Array(samples),
    sampleRate,
    channels,
    samplesPerChannel: samples,
  };
}

describe('STT', () => {
  it('has correct label', () => {
    const sttInstance = new STT({ authToken: 'test', apiUrl: 'http://stt:8080' });
    expect(sttInstance.label).toBe('blaze.STT');
  });

  it('throws when stream() is called', () => {
    const sttInstance = new STT({ authToken: 'test', apiUrl: 'http://stt:8080' });
    expect(() => sttInstance.stream()).toThrow('Blaze STT does not support streaming recognition');
  });

  it('updateOptions changes language without throwing', () => {
    const sttInstance = new STT({ authToken: 'test', apiUrl: 'http://stt:8080', language: 'vi' });
    expect(() => sttInstance.updateOptions({ language: 'en' })).not.toThrow();
  });

  describe('_recognize with mocked fetch', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('sends correct request to transcribe endpoint', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ transcription: 'hello world', confidence: 0.95 }),
      });

      const sttInstance = new STT({
        authToken: 'test-token',
        apiUrl: 'http://stt:8080',
        language: 'vi',
      }) as STTWithRecognize;
      const frame = makePcmFrame();
      await sttInstance._recognize([frame]);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/v1/stt/transcribe');
      expect(url).toContain('language=vi');
      expect(url).toContain('enable_segments=false');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    });

    it('returns FINAL_TRANSCRIPT with transcription text', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ transcription: 'xin chào', confidence: 0.99 }),
      });

      const sttInstance = new STT({
        authToken: 'tok',
        apiUrl: 'http://stt:8080',
        language: 'vi',
      }) as STTWithRecognize;
      const frame = makePcmFrame();
      const event = await sttInstance._recognize([frame]);
      const ev = event as {
        type: number;
        alternatives: Array<{ text: string; confidence: number; language: string }>;
      };

      expect(ev.type).toBe(2); // SpeechEventType.FINAL_TRANSCRIPT = 2
      expect(ev.alternatives[0]!.text).toBe('xin chào');
      expect(ev.alternatives[0]!.confidence).toBe(0.99);
      expect(ev.alternatives[0]!.language).toBe('vi');
    });

    it('applies normalization rules to transcription', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ transcription: 'AI is great', confidence: 0.9 }),
      });

      const sttInstance = new STT({
        authToken: 'tok',
        apiUrl: 'http://stt:8080',
        normalizationRules: { AI: 'trí tuệ nhân tạo' },
      }) as STTWithRecognize;

      const frame = makePcmFrame();
      const event = await sttInstance._recognize([frame]);
      const ev = event as { alternatives: Array<{ text: string }> };
      expect(ev.alternatives[0]!.text).toBe('trí tuệ nhân tạo is great');
    });

    it('returns event with no alternatives for empty audio', async () => {
      const sttInstance = new STT({
        authToken: 'tok',
        apiUrl: 'http://stt:8080',
      }) as STTWithRecognize;
      // Empty frame: 0 samples
      const emptyFrame = makePcmFrame(0);
      const event = await sttInstance._recognize([emptyFrame]);
      const ev = event as { type: number; alternatives?: unknown[] };

      expect(ev.type).toBe(2); // FINAL_TRANSCRIPT
      expect(ev.alternatives).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws on HTTP error response', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      });

      const sttInstance = new STT({
        authToken: 'tok',
        apiUrl: 'http://stt:8080',
      }) as STTWithRecognize;
      const frame = makePcmFrame();

      await expect(sttInstance._recognize([frame])).rejects.toThrow('Blaze STT error 400');
    }, 20000);

    it('uses language from options in URL', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ transcription: 'hello', confidence: 1.0 }),
      });

      const sttInstance = new STT({
        authToken: 'tok',
        apiUrl: 'http://stt:8080',
        language: 'en',
      }) as STTWithRecognize;
      await sttInstance._recognize([makePcmFrame()]);

      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [url] = firstCall! as [string];
      expect(url).toContain('language=en');
    });

    it('sends a valid WAV file with correct RIFF header', async () => {
      let capturedBody: FormData | undefined;
      fetchMock.mockImplementation(async (_url: unknown, init: RequestInit) => {
        capturedBody = init.body as FormData;
        return { ok: true, json: async () => ({ transcription: '', confidence: 1.0 }) };
      });

      const sttInstance = new STT({
        authToken: 'tok',
        apiUrl: 'http://stt:8080',
      }) as STTWithRecognize;
      const frame = makePcmFrame(160, 16000, 1); // 160 samples, 16kHz, mono
      await sttInstance._recognize([frame]);

      // Extract the WAV Blob from FormData
      expect(capturedBody).toBeDefined();
      const wavBlob = capturedBody!.get('audio_file') as Blob;
      expect(wavBlob).toBeInstanceOf(Blob);

      const arrayBuffer = await wavBlob.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);

      // WAV RIFF header is 44 bytes + PCM data
      // 160 samples × 2 bytes (Int16) = 320 bytes PCM
      expect(buf.length).toBe(44 + 320);

      // Verify RIFF header fields
      expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
      expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
      expect(buf.toString('ascii', 12, 16)).toBe('fmt ');
      expect(buf.readUInt32LE(16)).toBe(16); // Subchunk1 size (PCM)
      expect(buf.readUInt16LE(20)).toBe(1); // Audio format (PCM = 1)
      expect(buf.readUInt16LE(22)).toBe(1); // Channels (mono)
      expect(buf.readUInt32LE(24)).toBe(16000); // Sample rate
      expect(buf.readUInt16LE(34)).toBe(16); // Bits per sample
      expect(buf.toString('ascii', 36, 40)).toBe('data');
      expect(buf.readUInt32LE(40)).toBe(320); // Data chunk size
    });

    it('applies longer normalization rules first for deterministic results', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        // Input has 'A' (short) and 'AB' (long, overlaps with 'A')
        json: async () => ({ transcription: 'A AB', confidence: 0.9 }),
      });

      const sttInstance = new STT({
        authToken: 'tok',
        apiUrl: 'http://stt:8080',
        normalizationRules: {
          A: 'X', // shorter (length 1)
          AB: 'Y', // longer  (length 2) — must be applied first
        },
      }) as STTWithRecognize;

      const event = await sttInstance._recognize([makePcmFrame()]);
      const ev = event as { alternatives: Array<{ text: string }> };
      // Longer-first: 'AB'→'Y' gives 'A Y', then 'A'→'X' gives 'X Y'
      // Shorter-first: 'A'→'X' gives 'X XB', then 'AB' not found → 'X XB' (wrong)
      expect(ev.alternatives[0]!.text).toBe('X Y');
    });
  });

  describe('frame accumulation', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function emptyFetchResponse() {
      return { ok: true, json: async () => ({ transcription: '', confidence: 0.0 }) };
    }

    function textFetchResponse(text: string) {
      return { ok: true, json: async () => ({ transcription: text, confidence: 0.95 }) };
    }

    it('empty STT response buffers PCM and returns SpeechData with empty text', async () => {
      fetchMock.mockResolvedValue(emptyFetchResponse());

      const sttInstance = new STT({ authToken: 'tok', apiUrl: 'http://stt:8080' }) as STTWithRecognize & {
        _pendingPcm: Buffer;
        _pendingEmptyCount: number;
      };

      const frame = makePcmFrame(160); // 160 samples = 320 bytes PCM
      const event = await sttInstance._recognize([frame]) as {
        type: number;
        alternatives?: Array<{ text: string; confidence: number }>;
      };

      // Should return SpeechData with empty text (not undefined alternatives)
      expect(event.type).toBe(2); // FINAL_TRANSCRIPT
      expect(event.alternatives).toBeDefined();
      expect(event.alternatives![0]!.text).toBe('');
      expect(event.alternatives![0]!.confidence).toBe(0.0);
    });

    it('buffers PCM from empty result and prepends on next call', async () => {
      // First call: empty result → buffer
      fetchMock.mockResolvedValueOnce(emptyFetchResponse());
      // Second call: capture body size
      let capturedWavSize = 0;
      fetchMock.mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
        const fd = init.body as FormData;
        const blob = fd.get('audio_file') as Blob;
        capturedWavSize = (await blob.arrayBuffer()).byteLength;
        return textFetchResponse('xin chao');
      });

      const sttInstance = new STT({ authToken: 'tok', apiUrl: 'http://stt:8080' }) as STTWithRecognize;
      const frame = makePcmFrame(160, 16000, 1); // 320 bytes PCM each

      await sttInstance._recognize([frame]); // first: empty → buffer
      await sttInstance._recognize([frame]); // second: prepend + submit

      // WAV = 44 header + (320 pending + 320 new) = 44 + 640
      expect(capturedWavSize).toBe(44 + 640);
    });

    it('successful result clears pending buffer', async () => {
      fetchMock.mockResolvedValueOnce(emptyFetchResponse());
      fetchMock.mockResolvedValueOnce(textFetchResponse('xin chao'));

      const sttInstance = new STT({ authToken: 'tok', apiUrl: 'http://stt:8080' }) as STTWithRecognize;
      const frame = makePcmFrame(160);

      await sttInstance._recognize([frame]); // empty → buffer

      // After success, third call should send only single frame (no pending)
      let capturedWavSize = 0;
      fetchMock.mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
        const fd = init.body as FormData;
        const blob = fd.get('audio_file') as Blob;
        capturedWavSize = (await blob.arrayBuffer()).byteLength;
        return textFetchResponse('hello');
      });

      const result2 = await sttInstance._recognize([frame]); // success → clear pending
      expect((result2 as { alternatives: Array<{ text: string }> }).alternatives[0]!.text).toBe('xin chao');

      await sttInstance._recognize([frame]); // third: should be single frame only
      expect(capturedWavSize).toBe(44 + 320); // no pending prepended
    });

    it('discards buffer after maxPendingSegments consecutive empties', async () => {
      // 3 empties → buffered; 4th empty → discard
      fetchMock.mockResolvedValue(emptyFetchResponse());

      const sttInstance = new STT({ authToken: 'tok', apiUrl: 'http://stt:8080' }) as STTWithRecognize;
      const frame = makePcmFrame(160);

      for (let i = 0; i < 3; i++) {
        await sttInstance._recognize([frame]);
      }
      // After 3 calls: pendingPcm should be non-empty
      // Send 4th empty: count exceeds maxPendingSegments (3)
      await sttInstance._recognize([frame]);

      // After discard: next call should send only single frame (320 bytes PCM)
      let capturedWavSize = 0;
      fetchMock.mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
        const fd = init.body as FormData;
        const blob = fd.get('audio_file') as Blob;
        capturedWavSize = (await blob.arrayBuffer()).byteLength;
        return textFetchResponse('hello');
      });

      await sttInstance._recognize([frame]);
      expect(capturedWavSize).toBe(44 + 320); // no pending after discard
    });

    it('discards buffer when duration exceeds maxPendingDuration', async () => {
      fetchMock.mockResolvedValue(emptyFetchResponse());

      const sttInstance = new STT({ authToken: 'tok', apiUrl: 'http://stt:8080' }) as STTWithRecognize;

      // At 16kHz, 16-bit, mono: 5s = 5 * 16000 * 2 = 160000 bytes
      // Use a large frame whose PCM > 160000 bytes
      const largeSamples = 80500; // 161000 bytes > 160000
      const largeFrame = makePcmFrame(largeSamples);

      await sttInstance._recognize([largeFrame]);

      // After discard: next call should send only single frame
      let capturedWavSize = 0;
      fetchMock.mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
        const fd = init.body as FormData;
        const blob = fd.get('audio_file') as Blob;
        capturedWavSize = (await blob.arrayBuffer()).byteLength;
        return textFetchResponse('hello');
      });

      const smallFrame = makePcmFrame(160);
      await sttInstance._recognize([smallFrame]);
      expect(capturedWavSize).toBe(44 + 320); // only smallFrame, no pending
    });
  });
});
