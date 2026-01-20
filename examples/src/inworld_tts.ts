// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  metrics,
  voice,
} from '@livekit/agents';
import * as inworld from '@livekit/agents-plugin-inworld';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it in 1-2 short sentences.",
    });

    // Create TTS instance
    const tts = new inworld.TTS({
      timestampType: 'WORD',
      voice: 'Hades',
      model: 'inworld-tts-1',
      encoding: 'LINEAR16',
      textNormalization: 'ON',
      bitRate: 64000,
      sampleRate: 24000,
      speakingRate: 1.0,
      temperature: 1.1,
      bufferCharThreshold: 100,
      maxBufferDelayMs: 3000,
    });

    // List available voices
    tts
      .listVoices()
      .then((voices: inworld.Voice[]) => {
        console.log(`[Inworld TTS] ${voices.length} voices available in this workspace`);
        if (voices.length > 0) {
          console.log(
            '[Inworld TTS] Logging information for first voice:',
            JSON.stringify(voices[0], null, 2),
          );
        }
      })
      .catch((err: Error) => {
        console.error('[Inworld TTS] Failed to list voices:', err);
      });

    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // See all available models at https://docs.livekit.io/agents/models/stt/
      stt: 'assemblyai/universal-streaming:en',
      // A Large Language Model (LLM) is your agent's brain, processing user input and generating a response
      // See all available models at https://docs.livekit.io/agents/models/llm/
      llm: 'openai/gpt-4.1-mini',
      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // See all available models as well as voice selections at https://docs.livekit.io/agents/models/tts/
      tts,
      // VAD and turn detection are used to determine when the user is speaking and when the agent should respond
      // See more at https://docs.livekit.io/agents/build/turns
      vad: ctx.proc.userData.vad! as silero.VAD,
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      // to use realtime model, replace the stt, llm, tts and vad with the following
      // llm: new openai.realtime.RealtimeModel(),
      voiceOptions: {
        // allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: true,
      },
    });

    // timestamp handling (if enabled)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.tts!.on('alignment' as any, (data: any) => {
      if (data.wordAlignment) {
        const { words, starts, ends } = data.wordAlignment;
        for (let i = 0; i < words.length; i++) {
          console.log(`[Inworld TTS] Word: "${words[i]}", Start: ${starts[i]}, End: ${ends[i]}`);
        }
      }
      if (data.characterAlignment) {
        const { chars, starts, ends } = data.characterAlignment;
        for (let i = 0; i < chars.length; i++) {
          console.log(`[Inworld TTS] Char: "${chars[i]}", Start: ${starts[i]}, End: ${ends[i]}`);
        }
      }
    });

    const usageCollector = new metrics.UsageCollector();

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    session.say('Hello, how can I help you today?');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
