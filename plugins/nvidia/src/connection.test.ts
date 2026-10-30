// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { initializeLogger } from '@livekit/agents';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { RivaConnection } from './connection.js';
import { RivaSpeechSynthesis } from './proto.js';
import { STT } from './stt.js';
import { TTS } from './tts.js';

beforeAll(() => initializeLogger({ pretty: false, level: 'silent' }));
afterEach(() => vi.unstubAllEnvs());

it('reuses its channel and sends authentication metadata only with TLS', () => {
  const options = {
    apiKey: 'test-key',
    functionId: 'test-function',
    server: '127.0.0.1:1',
    useSsl: true,
  };
  const secure = new RivaConnection(options, RivaSpeechSynthesis);
  const local = new RivaConnection({ ...options, useSsl: false }, RivaSpeechSynthesis);
  try {
    expect(secure.metadata.get('authorization')).toEqual(['Bearer test-key']);
    expect(secure.metadata.get('function-id')).toEqual(['test-function']);
    expect(local.metadata.get('authorization')).toEqual([]);
    expect(local.metadata.get('function-id')).toEqual([]);
    expect(local.client).toBe(local.client);
  } finally {
    secure.close();
    local.close();
  }
});

it('reads the API key at construction when the option is undefined', async () => {
  vi.stubEnv('NVIDIA_API_KEY', 'environment-key');
  const stt = new STT({ apiKey: undefined });
  const tts = new TTS({ apiKey: undefined });
  await Promise.all([stt.close(), tts.close()]);
  vi.stubEnv('NVIDIA_API_KEY', '');
  expect(() => new STT()).toThrow('NVIDIA API key is required');
  expect(() => new TTS()).toThrow('NVIDIA API key is required');
});
