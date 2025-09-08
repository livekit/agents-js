// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
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
import { z } from 'zod';

const sttOptions = {
  deepgram: () => new deepgram.STT(),
};

const ttsOptions = {
  cartesia: () => new cartesia.TTS(),
  elevenlabs: () => new elevenlabs.TTS(),
  openai: () => new openai.TTS(),
  gemini: () => new google.beta.TTS(),
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
};

const realtimeLlmOptions = {
  openai: () => new openai.realtime.RealtimeModel(),
  gemini: () => new google.beta.realtime.RealtimeModel(),
};

const sttChoices = Object.keys(sttOptions);
const ttsChoices = Object.keys(ttsOptions) as (keyof typeof ttsOptions)[];
const eouChoices = Object.keys(eouOptions) as (keyof typeof eouOptions)[];
const llmChoices = Object.keys(llmOptions) as (keyof typeof llmOptions)[];
const realtimeLlmChoices = Object.keys(realtimeLlmOptions) as (keyof typeof realtimeLlmOptions)[];

type UserData = {
  testedSttChoices: Set<string>;
  testedTtsChoices: Set<string>;
  testedEouChoices: Set<string>;
  testedLlmChoices: Set<string>;
  testedRealtimeLlmChoices: Set<string>;
};

class MainAgent extends voice.Agent<UserData> {
  constructor() {
    super({
      instructions: `You are a main route agent, you can test the agent's ability to switch between different agents`,
      stt: sttOptions['deepgram'](),
      tts: ttsOptions['elevenlabs'](),
      llm: llmOptions['openai'](),
      turnDetection: eouOptions['multilingual'](),
      tools: {
        testAgent: llm.tool({
          description:
            'Called when user want to test an agent with STT, TTS, EOU, LLM, and optionally realtime LLM configuration',
          parameters: z.object({
            sttChoice: z.enum(sttChoices as [string, ...string[]]),
            ttsChoice: z.enum(ttsChoices as [string, ...string[]]),
            eouChoice: z.enum(eouChoices as [string, ...string[]]),
            llmChoice: z.enum(llmChoices as [string, ...string[]]),
            realtimeLlmChoice: z.enum(realtimeLlmChoices as [string, ...string[]]).nullable(),
          }),
          execute: async (params) => {
            const { sttChoice, ttsChoice, eouChoice, llmChoice, realtimeLlmChoice } = params;

            return llm.handoff({
              agent: new TestAgent({
                sttChoice: sttChoice as keyof typeof sttOptions,
                ttsChoice: ttsChoice as keyof typeof ttsOptions,
                eouChoice: eouChoice as keyof typeof eouOptions,
                llmChoice: llmChoice as keyof typeof llmOptions,
                realtimeLlmChoice: realtimeLlmChoice as keyof typeof realtimeLlmOptions | undefined,
              }),
              returns: 'Transfer to next agent',
            });
          },
        }),
      },
    });
  }

  async onEnter(): Promise<void> {
    if (this.llm instanceof llm.RealtimeModel) {
      this.session.generateReply({
        userInput: `Tell user that you are main route agent, you can test the agent's ability to switch between different agents`,
      });
    } else {
      this.session.say(
        `Hi, I'm a main route agent, you can test the agent's ability to switch between different agents`,
      );
    }
  }
}

class TestAgent extends voice.Agent<UserData> {
  private readonly sttChoice: keyof typeof sttOptions;
  private readonly ttsChoice: keyof typeof ttsOptions;
  private readonly eouChoice: keyof typeof eouOptions;
  private readonly llmChoice: keyof typeof llmOptions;
  private readonly realtimeLlmChoice?: keyof typeof realtimeLlmOptions;

  constructor({
    sttChoice,
    ttsChoice,
    eouChoice,
    llmChoice,
    realtimeLlmChoice,
  }: {
    sttChoice: keyof typeof sttOptions;
    ttsChoice: keyof typeof ttsOptions;
    eouChoice: keyof typeof eouOptions;
    llmChoice: keyof typeof llmOptions;
    realtimeLlmChoice?: keyof typeof realtimeLlmOptions;
  }) {
    const stt = sttOptions[sttChoice]();
    const tts = ttsOptions[ttsChoice]();
    const eou = eouOptions[eouChoice]();
    const model = llmOptions[llmChoice]();
    const realtimeModel = realtimeLlmChoice ? realtimeLlmOptions[realtimeLlmChoice]() : undefined;

    const modelName = realtimeModel ? `${realtimeLlmChoice} realtime` : llmChoice;

    super({
      instructions: `You are a test voice-based agent, you can hear the user's message and respond to it. User is testing your hearing & speaking abilities.
        You are using ${sttChoice} STT, ${ttsChoice} TTS, ${eouChoice} EOU, ${modelName} LLM.
        You can use the following tools to test your abilities:
        - testTool: Testing agent's tool calling ability
        - nextAgent: Called when user confirm current agent is working and want to proceed to next agent`,
      stt: stt,
      tts: tts,
      llm: realtimeModel ?? model,
      turnDetection: eou,
      tools: {
        testTool: llm.tool({
          description: "Testing agent's tool calling ability",
          parameters: z
            .object({
              randomString: z.string().describe('A random string'),
            })
            .describe('Test parameter'),
          execute: async (input) => {
            return {
              result: 'Tool been called with input: ' + JSON.stringify(input),
            };
          },
        }),
        nextAgent: llm.tool({
          description:
            'Called when user confirm current agent is working and want to proceed to next agent',
          parameters: z.object({
            sttChoice: z.enum(sttChoices as [string, ...string[]]).optional(),
            ttsChoice: z.enum(ttsChoices as [string, ...string[]]).optional(),
            eouChoice: z.enum(eouChoices as [string, ...string[]]).optional(),
            llmChoice: z.enum(llmChoices as [string, ...string[]]).optional(),
            realtimeLlmChoice: z.enum(realtimeLlmChoices as [string, ...string[]]).optional(),
          }),
          execute: async (params) => {
            const {
              sttChoice = this.sttChoice,
              ttsChoice = this.ttsChoice,
              eouChoice = this.eouChoice,
              llmChoice = this.llmChoice,
              realtimeLlmChoice = this.realtimeLlmChoice,
            } = params;

            return llm.handoff({
              agent: new TestAgent({
                sttChoice: sttChoice as keyof typeof sttOptions,
                ttsChoice: ttsChoice as keyof typeof ttsOptions,
                eouChoice: eouChoice as keyof typeof eouOptions,
                llmChoice: llmChoice as keyof typeof llmOptions,
                realtimeLlmChoice: realtimeLlmChoice as keyof typeof realtimeLlmOptions,
              }),
              returns: 'Transfer to next agent',
            });
          },
        }),
      },
    });

    this.sttChoice = sttChoice;
    this.ttsChoice = ttsChoice;
    this.eouChoice = eouChoice;
    this.llmChoice = llmChoice;
    this.realtimeLlmChoice = realtimeLlmChoice;
  }

  async onEnter(): Promise<void> {
    if (this.llm instanceof llm.RealtimeModel) {
      this.session.generateReply({
        userInput: `Tell user that you are voice agent with ${this.sttChoice} STT, ${this.ttsChoice} TTS, ${this.eouChoice} EOU, ${this.llmChoice} LLM`,
      });
    } else {
      this.session.say(
        `Hi, I'm a voice agent with ${this.sttChoice} STT, ${this.ttsChoice} TTS, ${this.eouChoice} EOU, ${this.llmChoice} LLM. I'm ready to test your hearing & speaking abilities.`,
      );
    }

    setTimeout(() => {
      if (this.session.currentAgent !== this) return;

      this.session.interrupt();
      this.session.generateReply({
        userInput: 'Tell user that this test is over, going back to main agent',
      });
      this.session.updateAgent(new MainAgent());
    }, 45 * 1000);
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const vad = ctx.proc.userData.vad! as silero.VAD;
    const session = new voice.AgentSession({
      vad,
      userData: {
        testedSttChoices: new Set(),
        testedTtsChoices: new Set(),
        testedEouChoices: new Set(),
        testedLlmChoices: new Set(),
        testedRealtimeLlmChoices: new Set(),
      },
    });
    const usageCollector = new metrics.UsageCollector();

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    await session.start({
      agent: new MainAgent(),

      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
