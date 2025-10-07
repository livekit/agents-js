// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import * as speechmatics from '@livekit/agents-plugin-speechmatics';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';

/**
 * Simple voice agent that uses the Speechmatics Realtime STT plugin.
 *
 * Requires SPEECHMATICS_API_KEY (or a custom getJwt() implementation) to be set.
 */
export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    const logger = log().child({ component: 'speechmatics-example' });
    logger.info('loading Silero VAD model');
    proc.userData.vad = await silero.VAD.load();
    logger.info('Silero VAD ready');
  },
  entry: async (ctx: JobContext) => {
    const logger = log().child({ component: 'speechmatics-example', roomName: ctx.room.name });
    logger.info('starting Speechmatics agent');
    const agent = new voice.Agent({
      instructions:
        'You are a helpful assistant. Listen to the caller, transcribe with Speechmatics, and answer helpfully.',
    });

    const vad = ctx.proc.userData.vad! as silero.VAD;

    logger.info('initializing Speechmatics STT');
    const stt = new speechmatics.STT({
      language: 'en',
      enableDiarization: true,
      endOfUtteranceMode: 'fixed',
    });
    logger.info(
      {
        language: 'en',
        enableDiarization: true,
        endOfUtteranceMode: 'fixed',
      },
      'Speechmatics STT configured',
    );

    const session = new voice.AgentSession({
      vad,
      stt,
      tts: new elevenlabs.TTS(),
      llm: new openai.LLM(),
      turnDetection: new livekit.turnDetector.EnglishModel(),
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      const { transcript, isFinal, speakerId } = ev;
      if (!transcript) return;
      if (isFinal) {
        logger.info({ transcript, speakerId }, 'final transcript');
      } else {
        logger.debug({ transcript, speakerId }, 'partial transcript');
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      logger.debug({ from: ev.oldState, to: ev.newState }, 'agent state changed');
    });

    session.on(voice.AgentSessionEventTypes.Error, (ev) => {
      logger.error({ error: ev.error }, 'agent session error');
    });

    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      logger.info({ reason: ev.reason, error: ev.error }, 'agent session closed');
    });

    const usageCollector = new metrics.UsageCollector();

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
      logger.debug({ metrics: ev.metrics }, 'metrics collected');
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    session.say('Speechmatics STT is live. What can I do for you today?');
    logger.info('Speechmatics agent session started');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
