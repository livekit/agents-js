// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { APIConnectOptions, initializeLogger, tokenize } from '@livekit/agents';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChunkedStream, type OutputFormat, TTS, type TTSOptions } from './tts.js';

// Mock socket.io-client
vi.mock('socket.io-client', () => ({
  Manager: vi.fn().mockImplementation(() => ({
    socket: vi.fn().mockReturnValue({
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      connected: false,
    }),
  })),
}));

describe('UpliftAI TTS', () => {
  const mockApiKey = 'test-api-key';
  const originalEnv = process.env;

  beforeAll(() => {
    // Initialize the logger before running tests
    initializeLogger({ pretty: false });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('TTS Constructor', () => {
    it('should create a TTS instance with API key from options', () => {
      const tts = new TTS({ apiKey: mockApiKey });
      expect(tts).toBeInstanceOf(TTS);
      expect(tts.label).toBe('upliftai.TTS');
      expect(tts.sampleRate).toBe(22050);
      expect(tts.numChannels).toBe(1);
    });

    it('should create a TTS instance with API key from environment', () => {
      process.env.UPLIFTAI_API_KEY = mockApiKey;
      const tts = new TTS();
      expect(tts).toBeInstanceOf(TTS);
    });

    it('should throw error when no API key is provided', () => {
      delete process.env.UPLIFTAI_API_KEY;
      expect(() => new TTS()).toThrow(
        'UpliftAI API key is required, either as argument or set UPLIFTAI_API_KEY environment variable',
      );
    });

    it('should use custom base URL from options', () => {
      const customURL = 'wss://custom.upliftai.org';
      const tts = new TTS({ apiKey: mockApiKey, baseURL: customURL });
      expect(tts).toBeInstanceOf(TTS);
    });

    it('should use base URL from environment', () => {
      process.env.UPLIFTAI_API_KEY = mockApiKey;
      process.env.UPLIFTAI_BASE_URL = 'wss://env.upliftai.org';
      const tts = new TTS();
      expect(tts).toBeInstanceOf(TTS);
    });

    it('should use custom voice ID', () => {
      const tts = new TTS({ apiKey: mockApiKey, voiceId: 'custom_voice' });
      expect(tts).toBeInstanceOf(TTS);
    });

    it('should handle different output formats', () => {
      const formats: OutputFormat[] = [
        'PCM_22050_16',
        'WAV_22050_16',
        'WAV_22050_32',
        'MP3_22050_32',
        'MP3_22050_64',
        'MP3_22050_128',
        'OGG_22050_16',
        'ULAW_8000_8',
      ];

      formats.forEach((format) => {
        const tts = new TTS({ apiKey: mockApiKey, outputFormat: format });
        expect(tts).toBeInstanceOf(TTS);
        if (format === 'ULAW_8000_8') {
          expect(tts.sampleRate).toBe(8000);
        } else {
          expect(tts.sampleRate).toBe(22050);
        }
      });
    });

    it('should accept custom tokenizer', () => {
      const customTokenizer = new tokenize.basic.WordTokenizer();
      const tts = new TTS({ apiKey: mockApiKey, tokenizer: customTokenizer });
      expect(tts).toBeInstanceOf(TTS);
    });

    it('should accept custom chunk timeout', () => {
      const tts = new TTS({ apiKey: mockApiKey, chunkTimeout: 5000 });
      expect(tts).toBeInstanceOf(TTS);
    });
  });

  describe('TTS Methods', () => {
    let tts: TTS;

    beforeEach(() => {
      tts = new TTS({ apiKey: mockApiKey });
    });

    afterEach(async () => {
      await tts.close();
    });

    it('should create a ChunkedStream when synthesize is called', () => {
      const text = 'Hello world';
      const stream = tts.synthesize(text);
      expect(stream).toBeInstanceOf(ChunkedStream);
      expect(stream.label).toBe('upliftai.ChunkedStream');
    });

    it('should create a SynthesizeStream when stream is called', () => {
      const stream = tts.stream();
      expect(stream).toBeDefined();
      expect(stream.label).toBe('upliftai.SynthesizeStream');
    });

    it('should handle close method gracefully', async () => {
      await expect(tts.close()).resolves.not.toThrow();
      // Calling close multiple times should not throw
      await expect(tts.close()).resolves.not.toThrow();
    });

    it('should pass connection options to synthesize', () => {
      const text = 'Test text';
      const connOptions = new APIConnectOptions({
        timeoutMs: 5000,
        maxRetry: 3,
      });
      const stream = tts.synthesize(text, connOptions);
      expect(stream).toBeInstanceOf(ChunkedStream);
    });

    it('should pass connection options to stream', () => {
      const connOptions = new APIConnectOptions({
        timeoutMs: 5000,
        maxRetry: 3,
      });
      const stream = tts.stream(connOptions);
      expect(stream).toBeDefined();
    });
  });

  describe('TTS Configuration Options', () => {
    it('should create instance with all options specified', () => {
      const options: TTSOptions = {
        apiKey: mockApiKey,
        baseURL: 'wss://custom.upliftai.org',
        voiceId: 'custom_voice_123',
        outputFormat: 'MP3_22050_128',
        tokenizer: new tokenize.basic.SentenceTokenizer(),
        chunkTimeout: 15000,
      };

      const tts = new TTS(options);
      expect(tts).toBeInstanceOf(TTS);
      expect(tts.sampleRate).toBe(22050);
      expect(tts.numChannels).toBe(1);
    });

    it('should use default values when options are not provided', () => {
      process.env.UPLIFTAI_API_KEY = mockApiKey;
      const tts = new TTS();
      expect(tts).toBeInstanceOf(TTS);
      expect(tts.sampleRate).toBe(22050); // Default for PCM_22050_16
      expect(tts.numChannels).toBe(1);
    });

    it('should prioritize options over environment variables', () => {
      process.env.UPLIFTAI_API_KEY = 'env-api-key';
      process.env.UPLIFTAI_BASE_URL = 'wss://env.upliftai.org';

      const tts = new TTS({
        apiKey: 'options-api-key',
        baseURL: 'wss://options.upliftai.org',
      });

      expect(tts).toBeInstanceOf(TTS);
      // We can't directly test the private fields, but the instance should be created successfully
    });
  });

  describe('ChunkedStream', () => {
    let tts: TTS;

    beforeEach(() => {
      tts = new TTS({ apiKey: mockApiKey });
    });

    afterEach(async () => {
      await tts.close();
    });

    it('should create ChunkedStream with input text', () => {
      const inputText = 'This is a test message';
      const stream = tts.synthesize(inputText);
      expect(stream).toBeInstanceOf(ChunkedStream);
      expect(stream.inputText).toBe(inputText);
    });

    it('should handle empty text input', () => {
      const stream = tts.synthesize('');
      expect(stream).toBeInstanceOf(ChunkedStream);
      expect(stream.inputText).toBe('');
    });

    it('should handle long text input', () => {
      const longText = 'Lorem ipsum '.repeat(100);
      const stream = tts.synthesize(longText);
      expect(stream).toBeInstanceOf(ChunkedStream);
      expect(stream.inputText).toBe(longText);
    });

    it('should handle special characters in text', () => {
      const specialText = "Hello! How are you? I'm fine. #test @user";
      const stream = tts.synthesize(specialText);
      expect(stream).toBeInstanceOf(ChunkedStream);
      expect(stream.inputText).toBe(specialText);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for invalid API key format', () => {
      expect(() => new TTS({ apiKey: '' })).toThrow(
        'UpliftAI API key is required, either as argument or set UPLIFTAI_API_KEY environment variable',
      );
    });

    it('should handle undefined environment variables gracefully', () => {
      delete process.env.UPLIFTAI_API_KEY;
      delete process.env.UPLIFTAI_BASE_URL;

      expect(() => new TTS()).toThrow(
        'UpliftAI API key is required, either as argument or set UPLIFTAI_API_KEY environment variable',
      );
    });
  });

  describe('Streaming capabilities', () => {
    let tts: TTS;

    beforeEach(() => {
      tts = new TTS({ apiKey: mockApiKey });
    });

    afterEach(async () => {
      await tts.close();
    });

    it('should indicate streaming support', () => {
      expect(tts.capabilities.streaming).toBe(true);
    });

    it('should create stream with default tokenizer', () => {
      const stream = tts.stream();
      expect(stream).toBeDefined();
      expect(stream.label).toBe('upliftai.SynthesizeStream');
    });

    it('should create stream with word tokenizer', () => {
      const wordTokenizer = new tokenize.basic.WordTokenizer();
      const ttsWithWordTokenizer = new TTS({
        apiKey: mockApiKey,
        tokenizer: wordTokenizer,
      });
      const stream = ttsWithWordTokenizer.stream();
      expect(stream).toBeDefined();
    });
  });
});
