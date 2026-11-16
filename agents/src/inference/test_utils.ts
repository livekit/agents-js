// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, vi } from 'vitest';
import type { LLM } from '../llm/llm.js';
import type { STT } from '../stt/stt.js';
import type { TTS } from '../tts/tts.js';
import type { VAD } from '../vad.js';

export async function createQuotaWebSocketServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_request, response) => {
    response.writeHead(429, {
      'X-LiveKit-Inference-Quota-Category': 'MaxGatewayCredits',
      'X-LiveKit-Inference-Quota-Message': 'Credit quota exhausted.',
      'X-LiveKit-Request-Id': 'quota-test-request',
      'X-Should-Retry': 'false',
    });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

interface InferenceTestHarness {
  llm: (model: LLM, skipOptionalArgs: boolean) => Promise<void>;
  llmStrict: (model: LLM) => Promise<void>;
  stt: (
    model: STT,
    vad: VAD,
    supports?: Partial<{ streaming: boolean; nonStreaming: boolean; streamSpeed: number }>,
  ) => Promise<void>;
  tts: (
    model: TTS,
    validationStt: STT,
    supports?: Partial<{ streaming: boolean; streamingValidationStt: boolean }>,
  ) => Promise<void>;
}

const shouldRunLiveKitInference = () =>
  process.env.LIVEKIT_INFERENCE_TESTS === '1' &&
  Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);

export const describeLiveKitInference = (
  name: string,
  agentsModule: object,
  registerTests: (harness: InferenceTestHarness) => Promise<void>,
) => {
  if (shouldRunLiveKitInference()) {
    describe(name, { timeout: 120_000 }, async () => {
      vi.doMock('@livekit/agents', () => agentsModule);
      // Import the shared harness source directly: declaring the test plugin as an agents
      // dependency would create a workspace cycle because the plugin already depends on agents.
      const testPackage = '../../../plugins/test/src/index.js';
      const harness: InferenceTestHarness = await import(/* @vite-ignore */ testPackage);
      await registerTests(harness);
    });
  } else {
    describe(name, () => {
      it.skip('requires LIVEKIT_INFERENCE_TESTS=1 and LiveKit credentials', () => {});
    });
  }
};
