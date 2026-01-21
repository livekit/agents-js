// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Example demonstrating TTS aligned transcripts feature.
 *
 * This example shows how to use the `useTtsAlignedTranscript` option to receive
 * word-level timestamps from TTS providers. When enabled, the transcription node
 * receives TimedString objects instead of raw text, allowing frontends to display
 * transcripts synchronized with audio playback.
 *
 * Ref: Python timed_agent_transcript.py - equivalent example in Python SDK
 *
 * Requirements:
 * - A TTS provider that supports aligned transcripts (Cartesia, ElevenLabs, or Inworld)
 * - Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET environment variables
 * - Set the TTS provider API key (e.g., CARTESIA_API_KEY)
 *
 * Run with: npx ts-node examples/src/timed_transcript_agent.ts dev
 */

import {
  type JobContext,
  type JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  llm,
  stream,
  voice,
} from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as silero from '@livekit/agents-plugin-silero';
import { ReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Type for the TimedString interface
// Ref: Python io.py line 94-117 - TimedString class definition
// Note: Python TimedString is a str subclass; JS uses interface since
// string primitives cannot have properties attached
type TimedString = voice.TimedString;

/**
 * Custom agent that demonstrates the timed transcript feature.
 * The transcriptionNode method is overridden to log timing information.
 */
class TimedTranscriptAgent extends voice.Agent {
  async transcriptionNode(
    text: ReadableStream<string | TimedString>,
    modelSettings: voice.ModelSettings,
  ): Promise<ReadableStream<string | TimedString> | null> {
    // Use IdentityTransform to create an output stream
    // Ref: Python agent.py line 284-307 - transcription_node signature
    const outputStream = new stream.IdentityTransform<string | TimedString>();
    const writer = outputStream.writable.getWriter();

    // Process the input stream and log timed transcripts
    (async () => {
      const reader = text.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (typeof value === 'object' && 'startTime' in value) {
            // This is a TimedString with timing information
            const ts = value as TimedString;
            console.log(
              `[TimedTranscript] "${ts.text.trim()}" (${ts.startTime?.toFixed(3)}s - ${ts.endTime?.toFixed(3)}s)`,
            );
          } else {
            // This is a plain string (when TTS aligned transcripts is disabled)
            console.log(`[Transcript] "${value}"`);
          }

          await writer.write(value);
        }
        await writer.close();
      } catch (e) {
        console.error('Error in transcriptionNode:', e);
        await writer.abort(e as Error);
      } finally {
        reader.releaseLock();
      }
    })();

    return outputStream.readable;
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    // Create a custom agent that logs timed transcripts
    const agent = new TimedTranscriptAgent({
      instructions:
        'You are a helpful assistant. Keep your responses brief so we can see the timed transcripts clearly.',
      // Enable TTS aligned transcripts for this agent
      // Ref: Python agent.py line 50, 80 - use_tts_aligned_transcript option
      useTtsAlignedTranscript: true,
      tools: {
        getTime: llm.tool({
          description: 'Get the current time.',
          parameters: z.object({}),
          execute: async () => {
            return `The current time is ${new Date().toLocaleTimeString()}.`;
          },
        }),
      },
    });

    // Create a TTS that supports aligned transcripts
    // Cartesia with wordTimestamps enabled (default: true)
    // Ref: Python cartesia/tts.py line 98 - word_timestamps option
    const tts = new cartesia.TTS({
      // wordTimestamps is true by default, but we're explicit here for demonstration
      wordTimestamps: true,
    });

    console.log(
      `TTS capabilities - streaming: ${tts.capabilities.streaming}, alignedTranscript: ${tts.capabilities.alignedTranscript}`,
    );

    const session = new voice.AgentSession({
      stt: 'assemblyai/universal-streaming:en',
      llm: 'openai/gpt-4.1-mini',
      tts,
      vad: ctx.proc.userData.vad! as silero.VAD,
      // You can also set useTtsAlignedTranscript at the session level
      // Agent-level setting takes precedence if both are set
      // Ref: Python agent_session.py line 89, 159 - useTtsAlignedTranscript option
      // useTtsAlignedTranscript: true,
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
      console.log(`[Event] Speech created: ${ev.speechHandle.id}`);
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      console.log(`[Event] Agent state changed: ${ev.oldState} -> ${ev.newState}`);
    });

    await session.start({
      agent,
      room: ctx.room,
    });

    // Say a greeting to demonstrate timed transcripts
    session.say('Hello! I can speak with word-level timing. Ask me anything!');
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
