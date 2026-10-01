// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Say one sentence in a LiveKit room using Microsoft AI TTS, without STT or an LLM.
 *
 * Run with `dev` and connect a playback-enabled, subscribe-only participant.
 * Set LIVEKIT_URL/API_KEY/API_SECRET for the server and MICROSOFT_AI_ENV_FILE for
 * the private TTS configuration. A local LiveKit server needs no Cloud account.
 */
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  log,
  voice,
  waitForParticipant,
  waitForTrackPublication,
} from '@livekit/agents';
import * as microsoft from '@livekit/agents-plugin-microsoft';
import { type LocalTrackPublication, TrackKind } from '@livekit/rtc-node';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GREETING = 'Hello, this is a Microsoft AI voice test.';

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const speech = new microsoft.TTS({ envFile: process.env.MICROSOFT_AI_ENV_FILE });
    const session = new voice.AgentSession({
      tts: speech,
      vad: null,
      turnHandling: { turnDetection: null },
      userAwayTimeout: null,
      connOptions: {
        ttsConnOptions: { maxRetry: 0, timeoutMs: 10_000 },
      },
    });

    try {
      await session.start({
        agent: new voice.Agent({ instructions: 'Speak only the supplied greeting.' }),
        room: ctx.room,
        inputOptions: { audioEnabled: false, videoEnabled: false, textEnabled: false },
        outputOptions: {
          audioSampleRate: speech.sampleRate,
          transcriptionEnabled: false,
        },
        record: false,
      });

      const readySignal = AbortSignal.timeout(30_000);
      await waitForParticipant({ room: ctx.room, signal: readySignal });
      const localIdentity = ctx.room.localParticipant?.identity;
      if (!localIdentity) throw new Error('Room has no local participant');
      const publication = (await waitForTrackPublication({
        room: ctx.room,
        identity: localIdentity,
        kind: TrackKind.KIND_AUDIO,
        includeLocal: true,
        signal: readySignal,
      })) as LocalTrackPublication;
      await withTimeout(
        publication.waitForSubscription(),
        30_000,
        'Timed out waiting for an audio subscriber',
      );

      const handle = session.say(GREETING, {
        allowInterruptions: false,
        addToChatCtx: false,
      });
      await withTimeout(handle.waitForPlayout(), 45_000, 'TTS room greeting timed out');
      const error = handle.exception();
      if (error) throw error;
      log().info('The one-shot TTS greeting finished playing to the room');
    } finally {
      try {
        await session.close();
      } finally {
        await speech.close();
      }
    }
    ctx.shutdown('TTS greeting complete');
  },
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), host: '127.0.0.1' }));
}
