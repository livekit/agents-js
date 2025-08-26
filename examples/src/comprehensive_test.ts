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
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as google from '@livekit/agents-plugin-google';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as neuphonic from '@livekit/agents-plugin-neuphonic';
import * as openai from '@livekit/agents-plugin-openai';
import * as resemble from '@livekit/agents-plugin-resemble';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { fileURLToPath } from 'node:url';

const sttOptions = {
  deepgram: () => new deepgram.STT(),
  openai: () => new openai.STT(),
};

const ttsOptions = {
  elevenlabs: () => new elevenlabs.TTS(),
  openai: () => new openai.TTS(),
  gemini: () => new google.beta.TTS(),
  cartesia: () => new cartesia.TTS(),
  neuphonic: () => new neuphonic.TTS(),
  resemble: () => new resemble.TTS(),
};

const eouOptions = {
  english: () => new livekit.turnDetector.EnglishModel(),
  multilingual: () => new livekit.turnDetector.MultilingualModel(),
};

const llmOptions = {
  openai: () => new openai.LLM(),
  gemini: () => new google.LLM(),
  openaiRealtime: () => new openai.realtime.RealtimeModel(),
  geminiRealtime: () => new google.beta.realtime.RealtimeModel(),
};

const sttChoices: (keyof typeof sttOptions)[] = Object.keys(
  sttOptions,
) as (keyof typeof sttOptions)[];
const ttsChoices: (keyof typeof ttsOptions)[] = Object.keys(
  ttsOptions,
) as (keyof typeof ttsOptions)[];
const eouChoices: (keyof typeof eouOptions)[] = Object.keys(
  eouOptions,
) as (keyof typeof eouOptions)[];
const llmChoices: (keyof typeof llmOptions)[] = Object.keys(
  llmOptions,
) as (keyof typeof llmOptions)[];

type UserData = {
  testedSttChoices: Set<string>;
  testedTtsChoices: Set<string>;
  testedEouChoices: Set<string>;
  testedLlmChoices: Set<string>;
};

class TestAgent extends voice.Agent {
  constructor(
    sttChoice: keyof typeof sttOptions,
    ttsChoice: keyof typeof ttsOptions,
    eouChoice: keyof typeof eouOptions,
    llmChoice: keyof typeof llmOptions,
  ) {
    const stt = sttOptions[sttChoice]();
    const tts = ttsOptions[ttsChoice]();
    const eou = eouOptions[eouChoice]();
    const llm = llmOptions[llmChoice]();

    super({
      instructions:
        "You are a test voice-based agent, you can hear the user's message and respond to it. User is testing your hearing & speaking abilities.",
      stt: stt,
      tts: tts,
      turnDetection: eou,
    });
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant, you can hear the user's message and respond to it.",
    });

    const vad = ctx.proc.userData.vad! as silero.VAD;

    const session = new voice.AgentSession({
      vad,
      stt: new deepgram.STT(),
      tts: new elevenlabs.TTS(),
      llm: new openai.LLM(),
      // to use realtime model, replace the stt, llm, tts and vad with the following
      // llm: new openai.realtime.RealtimeModel(),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
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

    // join the room when agent is ready
    await ctx.connect();

    session.say('Hello, how can I help you today?');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
