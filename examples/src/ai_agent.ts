// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
// import { mistral } from '@ai-sdk/mistral';
import { mistral } from '@ai-sdk/mistral';
import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  metrics,
  voice,
} from '@livekit/agents';
import * as aisdk from '@livekit/agents-plugin-aisdk';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config();

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const agent = new voice.Agent({
      instructions:
        "You are a helpful assistant called Karla, you can hear the user's message and respond to it.",
    });

    const vad = ctx.proc.userData.vad! as silero.VAD;

    const session = new voice.AgentSession({
      vad,
      stt: new deepgram.STT(),
      tts: new elevenlabs.TTS(),
      llm: new aisdk.LLM({
        model: mistral('mistral-large-latest'),
        tools: {
          createChannel: {
            description: 'Create a new discord channel with the given name',
            inputSchema: z.object({
              channelName: z.string(),
            }),
            execute: async ({ channelName }: { channelName: string }) => {
              try {
                const result = await ctx.room.localParticipant?.performRpc({
                  method: 'discord.room.create',
                  payload: channelName,
                  destinationIdentity: 'discord',
                });
                return `Channel ${channelName} created: ${result}`;
              } catch (error: any) {
                return `Error creating channel ${channelName}: ${error.message}`;
              }
            },
          },
          deleteChannel: {
            description: 'Delete the given discord channel',
            inputSchema: z.object({
              channelName: z.string(),
            }),
            execute: async ({ channelName }: { channelName: string }) => {
              try {
                const result = await ctx.room.localParticipant?.performRpc({
                  method: 'discord.room.delete',
                  payload: channelName,
                  destinationIdentity: 'discord',
                });
                return `Channel ${channelName} deleted: ${result}`;
              } catch (error: any) {
                return `Error deleting channel ${channelName}: ${error.message}`;
              }
            },
          },
          startWhip: {
            description: 'Start up ingress whip video stream',
            execute: async () => {
              try {
                const result = await ctx.room.localParticipant?.performRpc({
                  method: 'whip.start',
                  payload: '',
                  destinationIdentity: 'discord',
                });
                return `Whip video stream started: ${result}`;
              } catch (error: any) {
                return `Error starting whip video stream: ${error.message}`;
              }
            },
          },
          stopWhip: {
            description: 'Stop the ingress whip video stream',
            execute: async () => {
              try {
                const result = await ctx.room.localParticipant?.performRpc({
                  method: 'whip.stop',
                  payload: '',
                  destinationIdentity: 'discord',
                });
                return `Whip video stream stopped: ${result}`;
              } catch (error: any) {
                return `Error stopping whip video stream: ${error.message}`;
              }
            },
          },
          kickUserOut: {
            description: 'Kick the given user out of the voice channel',
            inputSchema: z.object({
              userId: z.string(),
            }),
            execute: async ({ userId }: { userId: string }) => {
              try {
                const result = await ctx.room.localParticipant?.performRpc({
                  method: 'discord.user.kick',
                  payload: userId,
                  destinationIdentity: 'discord',
                });
                return `User ${userId} kicked: ${result}`;
              } catch (error: any) {
                return `Error kicking user ${userId}: ${error.message}`;
              }
            },
          },
        },
      }),

      // to use realtime model, replace the stt, llm, tts and vad with the following
      // llm: new openai.realtime.RealtimeModel(),
      turnDetection: new livekit.turnDetector.EnglishModel(),
    });

    const usageCollector = new metrics.UsageCollector();

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    // join the room when agent is ready
    await ctx.connect();

    session.say('Hello, how can I help you today?');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: 'LiveCord' }));
