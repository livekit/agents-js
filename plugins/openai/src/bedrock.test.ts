// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { LLM } from './llm.js';
import { resolveBedrockBaseURL } from './models.js';
import { LLM as ResponsesLLM } from './responses/llm.js';

describe('resolveBedrockBaseURL', () => {
  it('routes gpt-oss to the mantle /v1 path', () => {
    expect(resolveBedrockBaseURL('openai.gpt-oss-120b', 'us-west-2')).toBe(
      'https://bedrock-mantle.us-west-2.api.aws/v1',
    );
  });

  it('defers gpt-5.x to the SDK default (/openai/v1)', () => {
    // returns undefined so BedrockOpenAI derives the /openai/v1 path itself
    expect(resolveBedrockBaseURL('openai.gpt-5.5', 'us-east-2')).toBeUndefined();
    expect(resolveBedrockBaseURL('openai.gpt-5.4', 'us-east-2')).toBeUndefined();
  });

  it('passes an explicit baseURL through unchanged', () => {
    const url = 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1';
    expect(resolveBedrockBaseURL('openai.gpt-oss-120b', 'us-west-2', url)).toBe(url);
  });
});

describe('LLM.withAWSBedrock (chat completions)', () => {
  it('defaults to gpt-oss-120b on the regional mantle endpoint', () => {
    const bedrock = LLM.withAWSBedrock({ apiKey: 'test-token', awsRegion: 'us-west-2' });
    expect(bedrock.model).toBe('openai.gpt-oss-120b');
    expect(bedrock.provider).toBe('bedrock-mantle.us-west-2.api.aws');
  });

  it('throws when apiKey and bedrockTokenProvider are both set', () => {
    expect(() =>
      LLM.withAWSBedrock({
        apiKey: 'test-token',
        bedrockTokenProvider: async () => 'another-token',
        awsRegion: 'us-west-2',
      }),
    ).toThrow();
  });
});

describe('responses.LLM.withAWSBedrock', () => {
  it('defaults to gpt-5.5', () => {
    const bedrock = ResponsesLLM.withAWSBedrock({ apiKey: 'test-token', awsRegion: 'us-east-2' });
    expect(bedrock.model).toBe('openai.gpt-5.5');
  });

  it('accepts gpt-5.4', () => {
    const bedrock = ResponsesLLM.withAWSBedrock({
      model: 'openai.gpt-5.4',
      apiKey: 'test-token',
      awsRegion: 'us-east-2',
    });
    expect(bedrock.model).toBe('openai.gpt-5.4');
  });
});
