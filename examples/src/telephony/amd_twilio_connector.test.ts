// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/** Ported from Python `test_twilio_connector_call_enters_amd_after_the_answer`. */
import type * as agents from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { entry } from './amd_twilio_connector.js';

// The example loads from the agents source tree, like `amd.test.ts`.
const source = vi.hoisted(() => ({
  load: async <T>(path: string): Promise<T> =>
    (await import(/* @vite-ignore */ `../../../agents/src/${path}`)) as T,
}));

const mocks = vi.hoisted(() => ({
  waitForTrackPublication: vi.fn(),
  connectTwilioCall: vi.fn(),
}));

// `voice` and `inference` are plain copies a test can patch, like monkeypatch.
vi.mock('@livekit/agents', async () => {
  const actual = await source.load<typeof agents>('index.js');
  return {
    ...actual,
    voice: { ...actual.voice },
    inference: { ...actual.inference },
    waitForTrackPublication: mocks.waitForTrackPublication,
  };
});

vi.mock('@livekit/noise-cancellation-node', () => ({
  BackgroundVoiceCancellation: vi.fn(() => ({})),
}));

vi.mock('livekit-server-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ConnectorClient: vi.fn(function () {
    return { connectTwilioCall: mocks.connectTwilioCall };
  }),
}));

const { voice, inference } = await import('@livekit/agents');
const { AMDCategory, AMDReason } = voice;
const { createAMDCompletedEvent } = await source.load<{
  createAMDCompletedEvent: (
    event: Omit<agents.voice.AMDCompletedEvent, 'type'>,
  ) => agents.voice.AMDCompletedEvent;
}>('voice/amd/events.js');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('AMD Twilio connector example', () => {
  it.each(['answered', 'voicemail', 'hung_up', 'unanswered', 'unconfigured'])(
    'connector call enters amd after the answer (%s)',
    async (outcome) => {
      vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC123');
      vi.stubEnv('TWILIO_AUTH_TOKEN', 'token');
      vi.stubEnv('TWILIO_FROM_NUMBER', '+15555550199');
      vi.stubEnv('TWILIO_TO_NUMBER', outcome === 'unconfigured' ? '' : '+15555550100');
      for (const name of ['STT', 'LLM', 'TTS'] as const) {
        (inference as Record<string, unknown>)[name] = vi.fn(function () {
          return {};
        });
      }
      const AgentSession = vi.fn(function (_options: unknown) {
        return { start: vi.fn(async () => {}), _roomIO: {} };
      });
      (voice as Record<string, unknown>).AgentSession = AgentSession;
      const result = createAMDCompletedEvent({
        category:
          (
            {
              voicemail: AMDCategory.MACHINE_VM,
              hung_up: AMDCategory.UNCERTAIN,
            } as Record<string, agents.voice.AMDCategory>
          )[outcome] ?? AMDCategory.HUMAN,
        reason:
          (
            {
              voicemail: AMDReason.IDLE_TIMEOUT,
              hung_up: AMDReason.PARTICIPANT_DISCONNECTED,
            } as Record<string, agents.voice.AMDReason>
          )[outcome] ?? AMDReason.FINISHED,
        voicemailMessagePlayed: outcome === 'voicemail',
        lastPrediction: null,
      });
      const detector = {
        on: vi.fn(),
        start: vi.fn(async () => detector),
        execute: vi.fn(async () => result),
        aclose: vi.fn(async () => {}),
      };
      const AMD = vi.fn(function (_session: unknown, _options: unknown) {
        return detector;
      });
      (voice as Record<string, unknown>).AMD = AMD;

      mocks.waitForTrackPublication.mockImplementation(async (options: { identity: string }) => {
        expect(options.identity).toBe('callee');
        // the connector publishes audio only after the answer, so AMD has not started yet
        expect(detector.start).not.toHaveBeenCalled();
        if (outcome === 'unanswered') {
          throw new Error('waitForTrackPublication aborted');
        }
        return { sid: 'track' };
      });
      mocks.connectTwilioCall.mockResolvedValue({ connectUrl: 'wss://connector/stream?a=1&b=2' });
      const twilio = vi.fn(async () => ({ ok: true, json: async () => ({ sid: 'CA123' }) }));
      vi.stubGlobal('fetch', twilio);

      const ctx = {
        room: { name: 'test-room' },
        shutdown: vi.fn(),
        addShutdownCallback: vi.fn(),
        deleteRoom: vi.fn(async () => {}),
      };
      await entry(ctx as unknown as agents.JobContext);

      // an outbound call skips the AEC warmup, as AgentSession does for outbound SIP
      expect(AgentSession.mock.calls[0]![0]).toMatchObject({ aecWarmupDuration: null });
      const [hangup] = ctx.addShutdownCallback.mock.calls[0]! as [() => Promise<void>];
      if (outcome === 'unconfigured') {
        expect(ctx.shutdown).toHaveBeenCalledExactlyOnceWith('missing Twilio configuration');
        expect(mocks.connectTwilioCall).not.toHaveBeenCalled();
        await hangup();
        expect(twilio).not.toHaveBeenCalled();
        expect(ctx.deleteRoom).toHaveBeenCalledOnce();
        return;
      }

      expect(mocks.connectTwilioCall).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ roomName: 'test-room', participantIdentity: 'callee' }),
      );
      const [url, init] = twilio.mock.calls[0]! as unknown as [string, { body: URLSearchParams }];
      expect(url).toMatch(/\/Calls\.json$/);
      expect(init.body.get('To')).toBe('+15555550100');
      expect(init.body.get('From')).toBe('+15555550199');
      expect(init.body.get('Twiml')).toContain('url="wss://connector/stream?a=1&amp;b=2"');
      if (outcome === 'unanswered') {
        expect(ctx.shutdown).toHaveBeenCalledExactlyOnceWith('call not answered');
        expect(AMD).not.toHaveBeenCalled();
      } else {
        expect(AMD).toHaveBeenCalledOnce();
        expect(AMD.mock.calls[0]![1]).toMatchObject({ participantIdentity: 'callee' });
        expect(detector.execute).toHaveBeenCalledOnce();
        expect(detector.aclose).toHaveBeenCalledOnce();
        if (outcome === 'voicemail') {
          expect(ctx.shutdown).toHaveBeenCalledExactlyOnceWith('voicemail completed');
        } else if (outcome === 'hung_up') {
          expect(ctx.shutdown).toHaveBeenCalledExactlyOnceWith('participant_disconnected');
        } else {
          expect(ctx.shutdown).not.toHaveBeenCalled();
        }
      }

      // every exit ends the Twilio call, even one still ringing, and deletes the room
      twilio.mockClear();
      await hangup();
      expect(twilio).toHaveBeenCalledOnce();
      const [endUrl, endInit] = twilio.mock.calls[0]! as unknown as [
        string,
        { body: URLSearchParams },
      ];
      expect(endUrl).toMatch(/\/Calls\/CA123\.json$/);
      expect(endInit.body.get('Status')).toBe('canceled');
      expect(ctx.deleteRoom).toHaveBeenCalledOnce();
    },
  );
});
