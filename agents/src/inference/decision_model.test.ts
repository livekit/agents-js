// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { Probability } from '../llm/decisions.js';
import { DecisionModel, type DecisionModelOptions } from './decision_model.js';

function response(bodyModel: string | null = 'jev-1.13.0', fallbackModel?: string): Response {
  return new Response(
    JSON.stringify({
      ...(bodyModel ? { model: bodyModel } : {}),
      answers: { check: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 1, output_tokens: 0 },
    }),
    {
      headers: fallbackModel
        ? { 'X-LiveKit-Inference-Decisions-Model-Fallback': fallbackModel }
        : undefined,
    },
  );
}

function model(options: Partial<DecisionModelOptions> = {}): DecisionModel {
  return new DecisionModel({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    baseURL: 'https://gateway.example/v1',
    ...options,
  });
}

describe('inference.DecisionModel fallback', () => {
  it.each([
    ['typesafe/jev', [{ model: 'typesafe/jev' }]],
    [
      ['typesafe/jev', 'livekit/clef-omni'],
      [{ model: 'typesafe/jev' }, { model: 'livekit/clef-omni' }],
    ],
    [[], []],
  ] as const)('sends fallback models %j to the gateway', async (fallback, sent) => {
    const fetch = vi.fn(async () => response());
    await model({
      fallback: Array.isArray(fallback) ? [...fallback] : fallback,
      fetch,
    }).evaluate({
      input: '',
      decisions: { check: new Probability('True?') },
    });
    const request = fetch.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body.fallback).toEqual({ models: sent });
  });

  it.each([
    ['jev-1.13.0', 'jev-1.13.0'],
    [null, 'typesafe/jev'],
  ] as const)('reports the fallback model that answered', async (bodyModel, reported) => {
    const result = await model({
      fetch: vi.fn(async () => response(bodyModel, 'typesafe/jev')),
    }).evaluate({ input: '', decisions: { check: new Probability('True?') } });
    expect(result.model).toBe(reported);
  });
});
