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
    expect(body.face_id).toBe('f1');
    expect(body.pal_id).toBe('p1');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('still accepts deprecated replicaId/personaId and warns', async () => {
    const f = mockFetchOk({ conversation_id: 'c2' });
    await new TavusAPI({ apiKey: 'k' }).createConversation({ replicaId: 'r1', personaId: 'x1' });
    const body = sentBody(f);
    expect(body.face_id).toBe('r1');
    expect(body.pal_id).toBe('x1');
    expect(warnMock).toHaveBeenCalledWith(
      { deprecatedName: 'replicaId', replacementName: 'faceId' },
      'deprecated option used',
    );
    expect(warnMock).toHaveBeenCalledWith(
      { deprecatedName: 'personaId', replacementName: 'palId' },
      'deprecated option used',
    );
  });

  it('does not warn when both the new and deprecated options are supplied', async () => {
    const f = mockFetchOk({ conversation_id: 'cb' });
    await new TavusAPI({ apiKey: 'k' }).createConversation({
      faceId: 'f1',
      replicaId: 'r1',
      palId: 'p1',
      personaId: 'x1',
    });
    // the new values win, so the deprecated aliases are unused -> no warning
    expect(warnMock).not.toHaveBeenCalled();
    const body = sentBody(f);
    expect(body.face_id).toBe('f1');
    expect(body.pal_id).toBe('p1');
  });

  it('falls back to TAVUS_FACE_ID / TAVUS_PAL_ID env vars', async () => {
    process.env.TAVUS_FACE_ID = 'envf';
    process.env.TAVUS_PAL_ID = 'envp';
    const f = mockFetchOk({ conversation_id: 'c3' });
    await new TavusAPI({ apiKey: 'k' }).createConversation();
    const body = sentBody(f);
    expect(body.face_id).toBe('envf');
    expect(body.pal_id).toBe('envp');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('with a face but no pal, uses the default stock pal and overrides its face', async () => {
    const f = mockFetchOk({ conversation_id: 'c5' });
    await new TavusAPI({ apiKey: 'k' }).createConversation({ faceId: 'f1' });
    expect(f).toHaveBeenCalledTimes(1); // no /v2/pals call
    expect(String(f.mock.calls[0]![0])).toContain('/conversations');
    const body = sentBody(f);
    expect(body.pal_id).toBe('pb87e71797da');
    expect(body.face_id).toBe('f1');
  });

  it('with only palId, skips pal creation and omits face_id (pal carries its own face)', async () => {
    const f = mockFetchOk({ conversation_id: 'c4' });
    await new TavusAPI({ apiKey: 'k' }).createConversation({ palId: 'p1' });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toContain('/conversations');
    const body = sentBody(f);
    expect(body.pal_id).toBe('p1');
    expect(body).not.toHaveProperty('face_id');
  });

  it('defaults to the stock pal when neither face nor pal is provided', async () => {
    const f = mockFetchOk({ conversation_id: 'c5' });
    await new TavusAPI({ apiKey: 'k' }).createConversation();
    expect(f).toHaveBeenCalledTimes(1); // no /v2/pals call
    const body = sentBody(f);
    expect(body.pal_id).toBe('pb87e71797da');
    expect(body).not.toHaveProperty('face_id');
  });
});
