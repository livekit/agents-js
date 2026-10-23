// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Microphone through Microsoft AI STT and TTS, without an LLM.
 *
 * Run with `dev` using a local LiveKit server and an explicitly started browser
 * microphone. MICROSOFT_AI_ENV_FILE selects the private STT/TTS configuration.
 * Microphone audio goes to STT; final text goes to TTS and transient room captions.
 * Use headphones. This example neither records audio nor logs transcripts.
 */
import {
  AgentSessionEventTypes,
  type ChatContext,
  type ChatMessage,
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  log,
  voice,
  waitForTrackPublication,
} from '@livekit/agents';
import * as microsoft from '@livekit/agents-plugin-microsoft';
import { TrackKind } from '@livekit/rtc-node';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SESSION_LIMIT_MS = 180_000;
const READY_TIMEOUT_MS = 10_000;
const VAD_SILENCE_MS = 500;

export function reportEchoSynthesisError(
  error: unknown,
  logger: Pick<ReturnType<typeof log>, 'error'> = log(),
): void {
  if (!error) return;
  const errorName = (error as { constructor?: { name?: string } }).constructor?.name;
  logger.error(`Echo synthesis failed (${errorName ?? 'UnknownError'})`);
}

export class EchoAgent extends voice.Agent {
  constructor() {
    super({ instructions: 'Echo the finalized user speech without an LLM.' });
  }

  override async onUserTurnCompleted(_turnCtx: ChatContext, newMessage: ChatMessage) {
    const text = newMessage.textContent;
    if (text) {
      const handle = this.session.say(text, {
        allowInterruptions: true,
        addToChatCtx: false,
      });
      handle.addDoneCallback((completed) => {
        reportEchoSynthesisError(completed.exception());
      });
    }
    throw new voice.StopResponse();
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const detector = new inference.VAD({ minSilenceDuration: VAD_SILENCE_MS });
    const envFile = process.env.MICROSOFT_AI_ENV_FILE;
    // Native STT needs its own VAD stream to commit; AgentSession's VAD does not do that.
    const recognizer = new microsoft.STT({ vad: detector, envFile });
    const speech = new microsoft.TTS({ envFile });
    const session = new voice.AgentSession({
      stt: recognizer,
      tts: speech,
      vad: detector,
      turnHandling: {
        turnDetection: 'stt',
        interruption: {
          enabled: true,
          mode: 'vad',
          minDuration: 200,
          minWords: 0,
          resumeFalseInterruption: false,
        },
        preemptiveGeneration: { enabled: false },
      },
      aecWarmupDuration: null,
      userAwayTimeout: null,
      connOptions: {
        sttConnOptions: { maxRetry: 0, timeoutMs: 10_000 },
        ttsConnOptions: { maxRetry: 0, timeoutMs: 10_000 },
        maxUnrecoverableErrors: 0,
      },
    });
    const closed = new Promise<void>((resolve) => {
      session.once(AgentSessionEventTypes.Close, () => resolve());
    });

    try {
      await session.start({
        agent: new EchoAgent(),
        room: ctx.room,
        inputOptions: {
          audioSampleRate: 16_000,
          textEnabled: false,
          videoEnabled: false,
        },
        outputOptions: {
          audioSampleRate: speech.sampleRate,
          transcriptionEnabled: true,
        },
        record: false,
      });

      await waitForTrackPublication({
        room: ctx.room,
        kind: TrackKind.KIND_AUDIO,
        waitForSubscription: true,
        signal: AbortSignal.timeout(READY_TIMEOUT_MS),
      });

      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            log().info('Echo demo reached its three-minute session limit');
            resolve();
          }, SESSION_LIMIT_MS);
          timeout.unref?.();
        }),
      ]);
      if (timeout) clearTimeout(timeout);
    } finally {
      try {
        await session.close();
      } finally {
        await Promise.allSettled([recognizer.close(), speech.close()]);
      }
    }
    ctx.shutdown('Echo session ended');
  },
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), host: '127.0.0.1' }));
}
