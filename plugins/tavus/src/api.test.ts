// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TavusAPI } from './api.js';

const warnMock = vi.hoisted(() => vi.fn());
vi.mock('./log.js', () => ({ log: () => ({ warn: warnMock, error: vi.fn() }) }));

function mockFetchOk(body: Record<string, unknown>) {
  const f = vi.fn().mockResolvedValue({ ok: true, json: async () => body } as Response);
  global.fetch = f as unknown as typeof fetch;
  return f;
}

function sentBody(f: ReturnType<typeof mockFetchOk>): Record<string, unknown> {
  return JSON.parse(String((f.mock.calls[0]![1] as RequestInit).body));
}

describe('Tavus TavusAPI.createConversation', () => {
  beforeEach(() => {
    warnMock.mockClear();
    for (const v of ['TAVUS_FACE_ID', 'TAVUS_PAL_ID', 'TAVUS_REPLICA_ID', 'TAVUS_PERSONA_ID']) {
      delete process.env[v];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps faceId/palId onto the unchanged wire keys without warning', async () => {
    const f = mockFetchOk({ conversation_id: 'c1' });
    const id = await new TavusAPI({ apiKey: 'k' }).createConversation({
      faceId: 'f1',
      palId: 'p1',
    });
    expect(id).toBe('c1');
    expect(f).toHaveBeenCalledTimes(1);
    const body = sentBody(f);
    expect(body.replica_id).toBe('f1');
    expect(body.persona_id).toBe('p1');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('still accepts deprecated replicaId/personaId and warns', async () => {
    const f = mockFetchOk({ conversation_id: 'c2' });
    await new TavusAPI({ apiKey: 'k' }).createConversation({ replicaId: 'r1', personaId: 'x1' });
    const body = sentBody(f);
    expect(body.replica_id).toBe('r1');
    expect(body.persona_id).toBe('x1');
    const msgs = warnMock.mock.calls.map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes('replicaId') && m.includes('faceId'))).toBe(true);
    expect(msgs.some((m) => m.includes('personaId') && m.includes('palId'))).toBe(true);
  });

  it('falls back to TAVUS_FACE_ID / TAVUS_PAL_ID env vars', async () => {
    process.env.TAVUS_FACE_ID = 'envf';
    process.env.TAVUS_PAL_ID = 'envp';
    const f = mockFetchOk({ conversation_id: 'c3' });
    await new TavusAPI({ apiKey: 'k' }).createConversation();
    const body = sentBody(f);
    expect(body.replica_id).toBe('envf');
    expect(body.persona_id).toBe('envp');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('throws TAVUS_FACE_ID must be set when no face id is provided', async () => {
    mockFetchOk({ conversation_id: 'c4' });
    await expect(new TavusAPI({ apiKey: 'k' }).createConversation({ palId: 'p1' })).rejects.toThrow(
      'TAVUS_FACE_ID must be set',
    );
  });
});
