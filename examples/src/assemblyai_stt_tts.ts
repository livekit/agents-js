// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  log,
  metrics,
  voice,
} from '@livekit/agents';
import * as assemblyai from '@livekit/agents-plugin-assemblyai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const logger = log();

// AssemblyAI recommends matching Silero's activation threshold (used here for barge-in)
// to the STT's vadThreshold, its default on Universal-3.6 Pro.
const VAD_THRESHOLD = 0.2;

class Assistant extends voice.Agent {
  constructor() {
    super({
      instructions:
        'You are a friendly voice assistant built on AssemblyAI speech-to-text and text-to-speech. ' +
        'Keep replies short and conversational: one or two sentences, no lists, no markdown, no ' +
        'emojis. Spell out anything that should be read aloud exactly, but write numbers, dates ' +
        'and prices normally; the voice expands them on its own.',
      tools: [
        llm.tool({
          name: 'lookupWeather',
          description: 'Called when the user asks about the weather.',
          parameters: z.object({
            location: z.string().describe('The city or region the user asked about'),
          }),
          execute: async ({ location }) => {
            logger.info({ location }, 'looking up weather');
            return 'sunny with a temperature of 72 degrees.';
          },
        }),
      ],
    });
  }

  async onEnter(): Promise<void> {
    this.session.generateReply({ instructions: 'Greet the user and introduce yourself.' });
  }
}

type ProcessUserData = {
  vad: silero.VAD;
};

export default defineAgent<ProcessUserData>({
  prewarm: async (proc) => {
    proc.userData.vad = (await silero.VAD.load({
      activationThreshold: VAD_THRESHOLD,
    })) as silero.VAD;
  },
  entry: async (ctx) => {
    const tts = new assemblyai.TTS({
      model: 'assemblyai-tts-1',
      // A voice's id, from the voice library or a cloned voice, see
      // https://www.assemblyai.com/docs/tts/voices. Pick the language with e.g. language: 'es'.
      voice: '987db62e-a2c2-569a-9c4d-82460cdea1bd', // Keegan
      // The US data zone by default; for the EU: baseUrl: 'wss://tts.eu.assemblyai.com'.
    });
    // Open the TTS socket now, so the first reply doesn't pay for the handshake.
    tts.prewarm();

    const session = new voice.AgentSession({
      stt: new assemblyai.STT({
        speechModel: 'universal-3-6-pro',
        // With turnDetection: 'stt': minTurnSilence: 128, maxTurnSilence: 1280.
        mode: 'balanced',
        vadThreshold: VAD_THRESHOLD,
      }),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      tts,
      vad: ctx.proc.userData.vad,
      turnHandling: {
        // AssemblyAI decides when the user has finished speaking.
        turnDetection: 'stt',
        // LiveKit's delay is added on top of AssemblyAI's own endpointing.
        endpointing: { minDelay: 0 },
        interruption: { resumeFalseInterruption: true },
      },
      ttsTextTransforms: ['filter_emoji', 'filter_markdown'],
      // Sync the transcript to AssemblyAI's word timings, so an interrupted reply is
      // recorded in the chat history up to the word the user actually heard.
      useTtsAlignedTranscript: true,
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
    });

    ctx.addShutdownCallback(async () => {
      logger.info({ usage: session.usage }, 'usage');
    });

    await session.start({ agent: new Assistant(), room: ctx.room });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
