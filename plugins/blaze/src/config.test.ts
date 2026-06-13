// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAuthHeaders, resolveConfig } from './config.js';

describe('resolveConfig', () => {
  beforeEach(() => {
    // Clear env vars before each test
    delete process.env.BLAZE_API_URL;
    delete process.env.BLAZE_API_TOKEN;
    delete process.env.BLAZE_STT_TIMEOUT;
    delete process.env.BLAZE_TTS_TIMEOUT;
    delete process.env.BLAZE_LLM_TIMEOUT;
  });

  afterEach(() => {
    delete process.env.BLAZE_API_URL;
    delete process.env.BLAZE_API_TOKEN;
  });

  it('uses defaults when no config or env vars provided', () => {
    const cfg = resolveConfig();
    expect(cfg.apiUrl).toBe('https://api.blaze.vn');
    expect(cfg.authToken).toBe('');
    expect(cfg.sttTimeout).toBe(30000);
    expect(cfg.ttsTimeout).toBe(60000);
    expect(cfg.llmTimeout).toBe(60000);
  });

  it('uses env vars when provided', () => {
    process.env.BLAZE_API_URL = 'http://api.example.com';
    process.env.BLAZE_API_TOKEN = 'test-token';
    const cfg = resolveConfig();
    expect(cfg.apiUrl).toBe('http://api.example.com');
    expect(cfg.authToken).toBe('test-token');
  });

  it('config values override env vars', () => {
    process.env.BLAZE_API_URL = 'http://env.example.com';
    const cfg = resolveConfig({ apiUrl: 'http://config.example.com' });
    expect(cfg.apiUrl).toBe('http://config.example.com');
  });

  it('timeout env vars are parsed as numbers', () => {
    process.env.BLAZE_STT_TIMEOUT = '15000';
    process.env.BLAZE_TTS_TIMEOUT = '45000';
    const cfg = resolveConfig();
    expect(cfg.sttTimeout).toBe(15000);
    expect(cfg.ttsTimeout).toBe(45000);
  });

  it('falls back to default timeout when env var is not a valid number', () => {
    process.env.BLAZE_STT_TIMEOUT = 'abc';
    process.env.BLAZE_TTS_TIMEOUT = '';
    process.env.BLAZE_LLM_TIMEOUT = '-500';
    const cfg = resolveConfig();
    expect(cfg.sttTimeout).toBe(30000); // fallback
    expect(cfg.ttsTimeout).toBe(60000); // fallback (empty string)
    expect(cfg.llmTimeout).toBe(60000); // fallback (negative value)
  });

  it('falls back to default timeout when env var is zero', () => {
    process.env.BLAZE_STT_TIMEOUT = '0';
    const cfg = resolveConfig();
    expect(cfg.sttTimeout).toBe(30000); // 0 is not a valid timeout
  });
});

describe('buildAuthHeaders', () => {
  it('returns empty object when no token', () => {
    const headers = buildAuthHeaders('');
    expect(headers).toEqual({});
  });

  it('returns Authorization header when token provided', () => {
    const headers = buildAuthHeaders('my-token');
    expect(headers).toEqual({ Authorization: 'Bearer my-token' });
  });
});
