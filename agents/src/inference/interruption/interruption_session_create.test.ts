// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Tests for the adaptive-interruption threshold negotiation contract. Ported from the Python
// `test_interruption_session_create.py` suite.
//
// The feature is server-driven: the SDK only sends `threshold` in `session.create` when the user
// explicitly overrode it, and otherwise omits the field so the server applies its fetched default.
// These tests lock that serialization contract plus the parsing of the server's `default_threshold`
// off `session.created` and the observability-only effective-threshold resolution.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLogger } from '../../log.js';
import { MockWebSocket } from './_mock_ws.js';
import { AdaptiveInterruptionDetector } from './interruption_detector.js';
import { InterruptionStreamBase } from './interruption_stream.js';
import { resolveEffectiveThreshold, wsMessageSchema } from './ws_transport.js';

// ---------------------------------------------------------------------------
// Mock `ws` so the WebSocket transport can be driven deterministically.
// ---------------------------------------------------------------------------

vi.mock('ws', async () => {
  const { MockWebSocket } = await import('./_mock_ws.js');
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

type MockSocket = MockWebSocket;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

initializeLogger({ pretty: false, level: 'silent' });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error('condition not met within timeout');
    }
    await sleep(5);
  }
}

function createDetector(opts: { threshold?: number } = {}): AdaptiveInterruptionDetector {
  return new AdaptiveInterruptionDetector({
    baseUrl: 'http://localhost:9999',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    ...opts,
  });
}

/** Run the real connect path and return the parsed session.create payload the transport sent. */
async function captureSessionCreate(
  detector: AdaptiveInterruptionDetector,
): Promise<{ settings: Record<string, unknown> }> {
  const stream = new InterruptionStreamBase(detector, {});
  try {
    await waitFor(() => MockWebSocket.instances.length > 0);
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1] as MockSocket;
    ws.simulateOpen();
    await waitFor(() => ws.sent.length > 0);
    return JSON.parse(String(ws.sent[0]));
  } finally {
    await stream.close();
  }
}

beforeEach(() => {
  MockWebSocket.instances.length = 0;
});

// ---------------------------------------------------------------------------
// session.create threshold serialization contract
// ---------------------------------------------------------------------------

describe('session.create threshold', () => {
  it('omits threshold when not given', async () => {
    const payload = await captureSessionCreate(createDetector());
    expect('threshold' in payload.settings).toBe(false);
  });

  it('includes threshold when overridden', async () => {
    const payload = await captureSessionCreate(createDetector({ threshold: 0.7 }));
    expect(payload.settings.threshold).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// session.created default_threshold parsing
// ---------------------------------------------------------------------------

describe('session.created default_threshold parsing', () => {
  it('parses default_threshold', () => {
    const msg = wsMessageSchema.parse({ type: 'session.created', default_threshold: 0.42 });
    expect(msg).toMatchObject({ type: 'session.created', default_threshold: 0.42 });
  });

  it('treats default_threshold as optional', () => {
    const msg = wsMessageSchema.parse({ type: 'session.created' }) as {
      default_threshold?: number | null;
    };
    expect(msg.default_threshold ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// effective-threshold resolution (observability only)
// ---------------------------------------------------------------------------

describe('resolveEffectiveThreshold', () => {
  it('prefers the user override', () => {
    expect(resolveEffectiveThreshold(0.7, 0.3)).toBe(0.7);
  });

  it('falls back to the server default', () => {
    expect(resolveEffectiveThreshold(undefined, 0.3)).toBe(0.3);
  });

  it('returns null when neither the user nor the server provides a value', () => {
    expect(resolveEffectiveThreshold(undefined, null)).toBeNull();
  });
});
