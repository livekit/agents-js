// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import { AgentSession } from './agent_session.js';
import { AMD, AMDCategory, type AMDPredictionEvent } from './amd.js';
import { AgentSessionEventTypes } from './events.js';
import { FakeLLM } from './testing/fake_llm.js';

it('the built SDK survives a prediction listener throwing during session shutdown', async () => {
  const entrypoint = new URL('../../dist/index.js', import.meta.url).href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        import { Agent, AgentSession, initializeLogger, voice } from ${JSON.stringify(entrypoint)};

        initializeLogger({ pretty: false, level: 'silent' });
        const session = new AgentSession({ llm: new voice.testing.FakeLLM(), turnDetection: 'manual' });
        await session.start({ agent: new Agent({ instructions: 'Help the caller.' }) });
        const amd = new voice.AMD(session, {
          llm: new voice.testing.FakeLLM(),
          suppressCompatibilityWarning: true,
        });
        let predictions = 0;
        let closed = false;
        amd.on('amd_prediction', () => {
          predictions += 1;
          throw new Error('prediction listener failed');
        });
        session.on(voice.AgentSessionEventTypes.Close, () => { closed = true; });
        const detection = amd.execute();
        void detection.catch(() => {});

        await session.close();
        const result = await detection;
        assert.equal(result.category, voice.AMDCategory.UNCERTAIN);
        assert.equal(result.reason, 'session_closed');
        assert.equal(predictions, 1);
        assert.equal(closed, true);
        await amd.aclose();
        await new Promise(setImmediate);
        console.log('shutdown completed');
      `,
    ],
    { env: { ...process.env, LIVEKIT_URL: '' }, timeout: 10_000 },
  );
  expect(stdout).toBe('shutdown completed\n');
}, 15_000);

describe('AMD session shutdown', () => {
  let session: AgentSession;
  let amd: AMD;
  let detection: Promise<AMDPredictionEvent>;
  const transcript = 'Please leave a message after the tone.';

  beforeEach(() => {
    vi.stubEnv('LIVEKIT_URL', '');
  });

  afterEach(async () => {
    await amd?.aclose();
    await detection?.catch(() => {});
    await session?.close().catch(() => {});
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function startDetection(category?: AMDCategory): Promise<void> {
    session = new AgentSession({ llm: new FakeLLM(), turnDetection: 'manual' });
    await session.start({ agent: new Agent({ instructions: 'Help the caller.' }) });
    amd = new AMD(session, {
      llm: new FakeLLM(
        category
          ? [
              {
                input: transcript,
                toolCalls: [{ name: 'save_prediction', args: { label: category } }],
              },
            ]
          : [],
      ),
      humanSilenceThresholdMs: 60_000,
      machineSilenceThresholdMs: 60_000,
      maxEndpointingDelayMs: 60_000,
      detectionTimeoutMs: 60_000,
      suppressCompatibilityWarning: true,
    });
    detection = amd.execute();
    void detection.catch(() => {});
    if (category) {
      amd.onUserSpeechStarted();
      amd.onTranscript(transcript, 'stt');
      await vi.waitFor(() => {
        expect(amd).toMatchObject({ verdictResult: { category }, settled: false });
      });
    }
  }

  it.each([
    AMDCategory.MACHINE_VM,
    AMDCategory.MACHINE_IVR,
    AMDCategory.MACHINE_UNAVAILABLE,
    AMDCategory.HUMAN,
  ])('delivers a pending %s verdict exactly once when the session closes', async (category) => {
    await startDetection(category);
    const onPrediction = vi.fn();
    const onClose = vi.fn();
    amd.on('amd_prediction', onPrediction);
    session.on(AgentSessionEventTypes.Close, onClose);

    await expect(session.close()).resolves.toBeUndefined();
    await expect(detection).resolves.toMatchObject({ category });
    await session.close();

    expect(onPrediction).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(amd).toMatchObject({ active: false, span: undefined });
  });

  it('releases a caller waiting for detection when the session closes before any speech', async () => {
    await startDetection();
    const onPrediction = vi.fn();
    amd.on('amd_prediction', onPrediction);

    await expect(session.close()).resolves.toBeUndefined();
    await expect(detection).resolves.toMatchObject({
      category: AMDCategory.UNCERTAIN,
      reason: 'session_closed',
    });
    expect(onPrediction).toHaveBeenCalledTimes(1);
    expect(amd).toMatchObject({ active: false, span: undefined });
  });

  it.each(['close', 'shutdown'] as const)(
    'releases an onExit handler waiting for detection during %s',
    async (method) => {
      await startDetection();
      const onExitResult = vi.fn();
      vi.spyOn(session.currentAgent, 'onExit').mockImplementation(async () => {
        onExitResult(await detection);
      });

      if (method === 'shutdown') session.shutdown();
      await expect(session.close()).resolves.toBeUndefined();
      expect(onExitResult).toHaveBeenCalledWith(
        expect.objectContaining({ category: AMDCategory.UNCERTAIN, reason: 'session_closed' }),
      );
    },
  );

  it('joins shutdown when a prediction listener calls close again', async () => {
    await startDetection();
    const onExit = vi.spyOn(session.currentAgent, 'onExit');
    let repeatedClose: Promise<void> | undefined;
    amd.on('amd_prediction', () => {
      repeatedClose = session.close();
    });

    await session.close();
    await repeatedClose;
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('settles immediately when execution starts after the session has closed', async () => {
    await startDetection();
    await session.close();
    await detection;

    await expect(amd.execute()).resolves.toMatchObject({
      category: AMDCategory.UNCERTAIN,
      reason: 'session_closed',
    });
    expect(amd).toMatchObject({ active: false, span: undefined });
  });

  it('can detect again after the session restarts', async () => {
    await startDetection();
    await session.close();
    await detection;
    await session.start({ agent: new Agent({ instructions: 'Help the caller.' }) });
    detection = amd.execute();
    void detection.catch(() => {});
    const onPrediction = vi.fn();
    amd.on('amd_prediction', onPrediction);

    await new Promise(setImmediate);
    expect(onPrediction).not.toHaveBeenCalled();
    await session.close();
    await expect(detection).resolves.toMatchObject({
      category: AMDCategory.UNCERTAIN,
      reason: 'session_closed',
    });
    expect(onPrediction).toHaveBeenCalledTimes(1);
  });

  it('preserves the result and clears state if reply authorization cannot resume', async () => {
    await startDetection();
    vi.spyOn(session, 'resumeReplyAuthorization').mockImplementation(() => {
      throw new Error('AgentSession is not running');
    });

    await session.close();
    await expect(detection).resolves.toMatchObject({ category: AMDCategory.UNCERTAIN });
    expect(amd).toMatchObject({ active: false, span: undefined });
  });

  it('still interrupts queued speech when a machine verdict arrives during a live session', async () => {
    await startDetection(AMDCategory.MACHINE_VM);
    const speech = session.generateReply({ userInput: 'Hello', allowInterruptions: false });
    expect(speech.interrupted).toBe(false);
    expect(speech.done()).toBe(false);

    amd.onUserSpeechEnded(60_001);
    amd.onEndOfTurn({
      newTranscript: transcript,
      transcriptConfidence: 1,
      transcriptionDelay: 0,
      endOfUtteranceDelay: 0,
      startedSpeakingAt: undefined,
      stoppedSpeakingAt: undefined,
    });

    await expect(detection).resolves.toMatchObject({ category: AMDCategory.MACHINE_VM });
    expect(speech.interrupted).toBe(true);
    expect(amd).toMatchObject({ active: false, span: undefined });
  });
});
