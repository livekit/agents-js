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
  //   openai: () => new openai.STT(),
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
  'openai realtime': () => new openai.realtime.RealtimeModel(),
  'gemini realtime': () => new google.beta.realtime.RealtimeModel(),
};

const sttChoices = Object.keys(sttOptions) as (keyof typeof sttOptions)[];
const ttsChoices = Object.keys(ttsOptions) as (keyof typeof ttsOptions)[];
const eouChoices = Object.keys(eouOptions) as (keyof typeof eouOptions)[];
const llmChoices = Object.keys(llmOptions) as (keyof typeof llmOptions)[];

type UserData = {
  testedSttChoices: Set<string>;
  testedTtsChoices: Set<string>;
  testedEouChoices: Set<string>;
  testedLlmChoices: Set<string>;
};

function getNextUnusedChoice<T>(choices: T[], used: Set<T>): T {
  const unused = choices.filter((choice) => !used.has(choice));
  if (unused.length === 0) {
    return choices[0]!;
  }
  return unused[0]!;
}

function isAllChoicesUsed(choices: string[], used: Set<string>): boolean {
  return choices.every((choice) => used.has(choice));
}

class TestAgent extends voice.Agent<UserData> {
  private readonly sttChoice: keyof typeof sttOptions;
  private readonly ttsChoice: keyof typeof ttsOptions;
  private readonly eouChoice: keyof typeof eouOptions;
  private readonly llmChoice: keyof typeof llmOptions;

  constructor({
    sttChoice,
    ttsChoice,
    eouChoice,
    llmChoice,
  }: {
    sttChoice: keyof typeof sttOptions;
    ttsChoice: keyof typeof ttsOptions;
    eouChoice: keyof typeof eouOptions;
    llmChoice: keyof typeof llmOptions;
  }) {
    const stt = sttOptions[sttChoice]();
    const tts = ttsOptions[ttsChoice]();
    const eou = eouOptions[eouChoice]();
    const model = llmOptions[llmChoice]();

    super({
      instructions: `You are a test voice-based agent, you can hear the user's message and respond to it. User is testing your hearing & speaking abilities.
        You are using ${sttChoice} STT, ${ttsChoice} TTS, ${eouChoice} EOU, ${llmChoice} LLM.
        You can use the following tools to test your abilities:
        - testTool: Testing agent's tool calling ability
        - nextAgent: Called when user confirm current agent is working and want to proceed to next agent`,
      stt: stt,
      tts: tts,
      llm: model,
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
          execute: async (_, { ctx }) => {
            try {
              ctx.userData.testedSttChoices.add(sttChoice);
              ctx.userData.testedTtsChoices.add(ttsChoice);
              ctx.userData.testedEouChoices.add(eouChoice);
              ctx.userData.testedLlmChoices.add(llmChoice);

              if (
                isAllChoicesUsed(sttChoices, ctx.userData.testedSttChoices) &&
                isAllChoicesUsed(ttsChoices, ctx.userData.testedTtsChoices) &&
                isAllChoicesUsed(eouChoices, ctx.userData.testedEouChoices) &&
                isAllChoicesUsed(llmChoices, ctx.userData.testedLlmChoices)
              ) {
                return {
                  result: 'All choices have been tested, you can stop now',
                };
              }

              const nextSttChoice = getNextUnusedChoice(
                sttChoices,
                ctx.userData.testedSttChoices,
              ) as keyof typeof sttOptions;
              const nextTtsChoice = getNextUnusedChoice(
                ttsChoices,
                ctx.userData.testedTtsChoices,
              ) as keyof typeof ttsOptions;
              const nextEouChoice = getNextUnusedChoice(
                eouChoices,
                ctx.userData.testedEouChoices,
              ) as keyof typeof eouOptions;
              const nextLlmChoice = getNextUnusedChoice(
                llmChoices,
                ctx.userData.testedLlmChoices,
              ) as keyof typeof llmOptions;

              return llm.handoff({
                agent: new TestAgent({
                  sttChoice: nextSttChoice,
                  ttsChoice: nextTtsChoice,
                  eouChoice: nextEouChoice,
                  llmChoice: nextLlmChoice,
                }),
                returns: 'Transferring to next text agent',
              });
            } catch (error) {
              return {
                result: 'Error transferring to next text agent: ' + error,
              };
            }
          },
        }),
      },
    });

    this.sttChoice = sttChoice;
    this.ttsChoice = ttsChoice;
    this.eouChoice = eouChoice;
    this.llmChoice = llmChoice;
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
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const vad = ctx.proc.userData.vad! as silero.VAD;
    const session = new voice.AgentSession({
      vad,
      userData: {
        testedSttChoices: new Set(),
        testedTtsChoices: new Set(),
        testedEouChoices: new Set(),
        testedLlmChoices: new Set(),
      },
    });
    const usageCollector = new metrics.UsageCollector();

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    await session.start({
      agent: new TestAgent({
        sttChoice: 'deepgram',
        ttsChoice: 'elevenlabs',
        eouChoice: 'english',
        llmChoice: 'openai',
      }),

      room: ctx.room,
      inputOptions: {
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
