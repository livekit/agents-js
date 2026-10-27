// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLM } from './llm.js';

const azureEnvVars = [
  'AZURE_OPENAI_API_KEY',
  'AZURE_API_KEY',
  'AZURE_OPENAI_AD_TOKEN',
  'AZURE_OPENAI_ENDPOINT',
  'OPENAI_API_VERSION',
  'OPENAI_BASE_URL',
];

describe('LLM.withAzure', () => {
  beforeEach(() => {
    for (const name of azureEnvVars) {
      vi.stubEnv(name, '');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const baseOpts = {
    model: 'my-model',
    azureEndpoint: 'https://example-resource.openai.azure.com',
    apiVersion: '2024-10-21',
  };

  it('reads the API key from AZURE_OPENAI_API_KEY and uses azureEndpoint and model', () => {
    vi.stubEnv('AZURE_OPENAI_API_KEY', 'azure-key');

    const llm = LLM.withAzure(baseOpts);

    expect(llm.provider).toBe('example-resource.openai.azure.com');
    expect(llm.model).toBe('my-model');
  });

  it('still accepts AZURE_API_KEY for backwards compatibility', () => {
    vi.stubEnv('AZURE_API_KEY', 'legacy-key');

    expect(() => LLM.withAzure(baseOpts)).not.toThrow();
  });

  it('accepts an Azure AD token provider without an API key', () => {
    const llm = LLM.withAzure({ ...baseOpts, azureAdTokenProvider: async () => 'token' });

    expect(llm.provider).toBe('example-resource.openai.azure.com');
  });

  it('accepts a static Azure AD token, including from AZURE_OPENAI_AD_TOKEN', () => {
    expect(() => LLM.withAzure({ ...baseOpts, azureAdToken: 'token' })).not.toThrow();

    vi.stubEnv('AZURE_OPENAI_AD_TOKEN', 'env-token');
    expect(() => LLM.withAzure(baseOpts)).not.toThrow();
  });

  it('throws when no credentials are available', () => {
    expect(() => LLM.withAzure(baseOpts)).toThrow(/AZURE_OPENAI_API_KEY/);
  });
});
