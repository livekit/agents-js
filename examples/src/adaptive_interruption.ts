// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * This example demonstrates how to use the AdaptiveInterruptionDetector
 * for detecting user interruptions during agent speech.
 *
 * The detector analyzes overlapping speech (when user speaks while agent is speaking)
 * and determines whether the user intends to interrupt or is just providing backchannel
 * feedback (like "uh-huh", "okay", etc).
 *
 * The interruption detection is integrated into AudioRecognition and works automatically
 * when the detector is provided along with VAD. It:
 * 1. Forwards audio frames to the detector when the agent is speaking
 * 2. Triggers overlap detection when VAD detects user speech during agent speech
 * 3. Emits interruption events that can be handled to stop/pause agent speech
 */
import {
  AdaptiveInterruptionDetector,
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  log,
  voice,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const logger = log();
    const vad = ctx.proc.userData.vad as silero.VAD;

    await ctx.connect();

    // Create the adaptive interruption detector with custom options
    const interruptionDetector = new AdaptiveInterruptionDetector({
      // Threshold for interruption classification (0-1)
      // Higher = less sensitive, lower = more sensitive
      threshold: 0.65,
      // Minimum duration of overlap speech to consider as potential interruption
      minInterruptionDuration: 0.05,
      // Maximum audio duration to analyze (including prefix)
      maxAudioDuration: 3.0,
      // Audio context to include before overlap started
      audioPrefixDuration: 0.5,
      // How often to run inference during overlap
      detectionInterval: 0.1,
    });

    // Listen for interruption events on the detector (optional - for logging/metrics)
    interruptionDetector.on('interruptionDetected', () => {
      logger.info('Interruption detected via detector event');
    });

    interruptionDetector.on('overlapSpeechDetected', () => {
      logger.info('Overlap speech ended without interruption (backchannel)');
    });

    // Create the agent
    const agent = new voice.Agent({
      instructions: `You are a helpful assistant that demonstrates interruption detection.
        Speak naturally and respond to the user. When you are interrupted,
        you will stop speaking and listen to the user.`,
    });

    // Create the session with interruption detection enabled
    // The detector is passed to AgentSession which wires it through to AudioRecognition
    const session = new voice.AgentSession({
      llm: 'openai/gpt-4.1-mini',
      stt: 'deepgram/nova-3',
      tts: 'cartesia/sonic-2:c45bc5ec-dc68-4feb-8829-6e6b2748095d',
      vad,
      // Pass the interruption detector
      interruptionDetector,
      voiceOptions: {
        allowInterruptions: false,
      },
    });

    // Start the session
    await session.start({
      agent,
      room: ctx.room,
    });

    // // Example: Dynamically adjust threshold based on context
    // // This could be useful to adapt to different conversation styles
    // setTimeout(() => {
    //   logger.info('Adjusting interruption threshold for more sensitive detection');
    //   interruptionDetector.updateOptions({
    //     threshold: 0.5, // More sensitive to interruptions
    //     minInterruptionDuration: 0.03, // Detect shorter interruptions
    //   });
    // }, 30000);

    session.say(
      'Hello! I can detect when you want to interrupt me versus when you are just saying things like uh-huh or okay. Try talking while I am speaking to see how it works!',
    );
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
