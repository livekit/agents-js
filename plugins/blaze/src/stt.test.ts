// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STT } from './stt.js';
import { initializeLogger } from '../../../agents/src/log.js';

initializeLogger({ level: 'silent', pretty: false });

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

      const sttInstance = new STT({ authToken: 'test-token', apiUrl: 'http://stt:8080', language: 'vi' }) as STTWithRecognize;
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

      const sttInstance = new STT({ authToken: 'tok', apiUrl: 'http://stt:8080', language: 'vi' }) as STTWithRecognize;
      const frame = makePcmFrame();
      const event = await sttInstance._recognize([frame]);
      const ev = event as { type: number; alternatives: Array<{ text: string; confidence: number; language: string }> };

      expect(ev.type).toBe(2); // SpeechEventType.FINAL_TRANSCRIPT = 2
      expect(ev.alternatives[0].text).toBe('xin chào');
      expect(ev.alternatives[0].confidence).toBe(0.99);
      expect(ev.alternatives[0].language).toBe('vi');
    });

    it('applies normalization rules to transcription', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ transcription: 'AI is great', confidence: 0.9 }),
      });

      const sttInstance = new STT({
        authToken: 'tok',
        apiUrl: 'http://stt:8080',
        normalizationRules: { 'AI': 'trí tuệ nhân tạo' },
      }) as STTWithRecognize;

      const frame = makePcmFrame();
      const event = await sttInstance._recognize([frame]);
      const ev = event as { alternatives: Array<{ text: string }> };
      expect(ev.alternatives[0].text).toBe('trí tuệ nhân tạo is great');
    });

    it('returns event with no alternatives for empty audio', async () => {
      const sttInstance = new STT({ authToken: 'tok', apiUrl: 'http://stt:8080' }) as STTWithRecognize;
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

      const sttInstance = new STT({ authToken: 'tok', apiUrl: 'http://stt:8080' }) as STTWithRecognize;
      const frame = makePcmFrame();

      await expect(sttInstance._recognize([frame])).rejects.toThrow('Blaze STT error 400');
    }, 20000);

    it('uses language from options in URL', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ transcription: 'hello', confidence: 1.0 }),
      });

      const sttInstance = new STT({ authToken: 'tok', apiUrl: 'http://stt:8080', language: 'en' }) as STTWithRecognize;
      await sttInstance._recognize([makePcmFrame()]);

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toContain('language=en');
    });

    it('sends a valid WAV file with correct RIFF header', async () => {
      let capturedBody: FormData | undefined;
      fetchMock.mockImplementation(async (_url: unknown, init: RequestInit) => {
        capturedBody = init.body as FormData;
        return { ok: true, json: async () => ({ transcription: '', confidence: 1.0 }) };
      });

      const sttInstance = new STT({ authToken: 'tok', apiUrl: 'http://stt:8080' }) as STTWithRecognize;
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
      expect(buf.readUInt32LE(16)).toBe(16);       // Subchunk1 size (PCM)
      expect(buf.readUInt16LE(20)).toBe(1);        // Audio format (PCM = 1)
      expect(buf.readUInt16LE(22)).toBe(1);        // Channels (mono)
      expect(buf.readUInt32LE(24)).toBe(16000);    // Sample rate
      expect(buf.readUInt16LE(34)).toBe(16);       // Bits per sample
      expect(buf.toString('ascii', 36, 40)).toBe('data');
      expect(buf.readUInt32LE(40)).toBe(320);      // Data chunk size
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
          'A': 'X',   // shorter (length 1)
          'AB': 'Y',  // longer  (length 2) — must be applied first
        },
      }) as STTWithRecognize;

      const event = await sttInstance._recognize([makePcmFrame()]);
      const ev = event as { alternatives: Array<{ text: string }> };
      // Longer-first: 'AB'→'Y' gives 'A Y', then 'A'→'X' gives 'X Y'
      // Shorter-first: 'A'→'X' gives 'X XB', then 'AB' not found → 'X XB' (wrong)
      expect(ev.alternatives[0].text).toBe('X Y');
    });
  });
});
