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

function optionalBool(value: unknown, { default: defaultValue }: { default: boolean }): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') {
      return true;
    }
    if (normalized === '0' || normalized === 'false') {
      return false;
    }
    throw new Error(`invalid boolean value: ${value}`);
  }
  throw new Error(`invalid boolean value: ${String(value)}`);
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    const agent = new voice.Agent({
      instructions: 'Talk to me!',
    });

    const session = new voice.AgentSession({
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'en',
      }),
      llm: new inference.LLM({
        model: 'openai/gpt-4.1-mini',
      }),
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      turnHandling: {
        interruption: {
          resumeFalseInterruption: false,
        },
      },
    });

    const agentImageUrl = process.env.LEMONSLICE_IMAGE_URL;
    if (!agentImageUrl) {
      throw new Error('LEMONSLICE_IMAGE_URL is required');
    }

    const avatar = new lemonslice.AvatarSession({
      agentImageUrl,
      agentPrompt: 'Be expressive in your movements and use your hands while talking.',
    });
    await avatar.start(session, ctx.room);

    const meta = ctx.job.metadata ? JSON.parse(ctx.job.metadata) : {};
    const meetingUrl = meta.meeting_url ?? process.env.MEETING_URL;
    if (!meetingUrl) {
      throw new Error('Set meeting_url in job metadata or MEETING_URL env var');
    }

    const listenToMeetingChat = optionalBool(
      meta.listen_to_meeting_chat ?? process.env.LISTEN_TO_MEETING_CHAT,
      { default: true },
    );
    const botName = meta.bot_name ?? process.env.MEETING_BOT_NAME;

    await avatar.joinMeeting(meetingUrl, {
      botName,
      listenToMeetingChat,
    });

    const roomOpts = avatar.roomOptions();

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: roomOpts.inputOptions,
      outputOptions: {
        ...roomOpts.outputOptions,
        syncTranscription: false,
      },
    });

    session.generateReply({
      instructions: 'Say hello to the user.',
    });
  },
});

cli.runApp(
  new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: 'lemonslice-meeting' }),
);
