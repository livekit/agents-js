// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  initializeLogger,
  voice,
} from '@livekit/agents';
import * as lemonslice from '@livekit/agents-plugin-lemonslice';
import { fileURLToPath } from 'node:url';

initializeLogger({ pretty: true });

function optionalBool(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Boolean(value);
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') {
      return true;
    }
    if (normalized === '0' || normalized === 'false') {
      return false;
    }
  }
  throw new Error(`invalid boolean value: ${String(value)}`);
}

function metadata(ctx: JobContext): Record<string, unknown> {
  if (!ctx.job.metadata) {
    return {};
  }
  return JSON.parse(ctx.job.metadata) as Record<string, unknown>;
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const meta = metadata(ctx);
    const agentImageUrl = process.env.LEMONSLICE_IMAGE_URL;
    if (!agentImageUrl) {
      throw new Error('LEMONSLICE_IMAGE_URL is required');
    }

    const meetingUrl = String(meta.meeting_url || process.env.MEETING_URL || '');
    if (!meetingUrl) {
      throw new Error('Set meeting_url in job metadata or MEETING_URL env var');
    }

    const session = new voice.AgentSession({
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'en',
      }),
      llm: new inference.LLM({
        model: 'google/gemini-2.5-flash',
      }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
      }),
      turnHandling: {
        interruption: {
          resumeFalseInterruption: false,
        },
      },
    });

    const avatar = new lemonslice.AvatarSession({
      agentImageUrl,
      agentPrompt: 'Be expressive in your movements and use your hands while talking.',
    });
    await avatar.start(session, ctx.room);

    const botName = String(meta.bot_name || process.env.MEETING_BOT_NAME || '');
    await avatar.joinMeeting(meetingUrl, {
      ...(botName ? { botName } : {}),
      listenToMeetingChat: optionalBool(
        meta.listen_to_meeting_chat ?? process.env.LISTEN_TO_MEETING_CHAT,
        true,
      ),
    });

    const agent = new voice.Agent({
      instructions: 'Talk to me!',
    });

    await session.start({
      agent,
      room: ctx.room,
      ...avatar.roomOptions(),
    });

    session.generateReply({
      instructions: 'say hello to the user',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
