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
  llm,
  voice,
} from '@livekit/agents';
import * as lemonslice from '@livekit/agents-plugin-lemonslice';
import { fileURLToPath } from 'node:url';
import { ActionController, supportsActions } from './actions.js';
import { holdBeats } from './hold_music.js';
import { type Persona, composeInstructions, resolvePersona } from './personas.js';

initializeLogger({ pretty: true });

interface State {
  persona: Persona;
  avatar: lemonslice.AvatarSession;
  sessionId: string;
}

function makeAvatar(persona: Persona): lemonslice.AvatarSession {
  return new lemonslice.AvatarSession({
    agentImageUrl: persona.imageUrl,
    agentPrompt: persona.speakingPrompt,
    idleTimeout: 120,
  });
}

function makeAgent(persona: Persona, actions: ActionController): voice.Agent {
  const tools = supportsActions(persona.id)
    ? {
        wave: llm.tool({
          description: 'Wave to the user. Only call when they explicitly ask you to wave.',
          execute: async () => actions.play('wave'),
        }),
        dance: llm.tool({
          description: 'Dance for the user. Only call when they explicitly ask you to dance.',
          execute: async () => actions.play('dance'),
        }),
        turn: llm.tool({
          description: 'Turn side to side. Only call when they explicitly ask you to turn.',
          execute: async () => actions.play('turn'),
        }),
      }
    : undefined;

  return new voice.Agent({
    instructions: composeInstructions(persona),
    tts: new inference.TTS({ model: 'cartesia/sonic-3.5', voice: persona.voiceId }),
    tools,
  });
}

function initialPersona(ctx: JobContext): Persona {
  const metadata = ctx.job.metadata
    ? (JSON.parse(ctx.job.metadata) as Record<string, unknown>)
    : {};
  return resolvePersona(metadata.set_avatar);
}

function requestedPersona(payload: string): Persona {
  const data = JSON.parse(payload) as { value?: unknown };
  return resolvePersona(data.value);
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const initial = initialPersona(ctx);
    const actions = new ActionController();
    ctx.addShutdownCallback(() => actions.shutdown());

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3' }),
      llm: new inference.LLM({ model: 'google/gemini-3.5-flash' }),
      turnHandling: {
        interruption: { resumeFalseInterruption: false },
      },
    });

    await ctx.connect();

    const avatar = makeAvatar(initial);
    const sessionId = await avatar.start(session, ctx.room);
    const state: State = { persona: initial, avatar, sessionId };

    if (supportsActions(initial.id)) {
      actions.setSession(state.sessionId, initial.id);
    }

    await session.start({
      agent: makeAgent(initial, actions),
      room: ctx.room,
    });

    if (supportsActions(initial.id)) {
      await actions.openingWave();
    }

    session.generateReply({
      instructions:
        `It's your turn to speak first. Open with a single short greeting in character as ${initial.name} and then stop.` +
        (supportsActions(initial.id) ? ' Do not call wave - you already waved.' : ''),
    });

    const bgAudio = new voice.BackgroundAudioPlayer();
    await bgAudio.start({ room: ctx.room, agentSession: session });

    let switching = false;

    ctx.room.localParticipant?.registerRpcMethod(
      'set_avatar',
      async (data: { payload: string }): Promise<string> => {
        if (switching) {
          throw new Error('Still switching to the previous persona, please try again in a moment.');
        }

        switching = true;
        try {
          const newPersona = requestedPersona(data.payload);

          if (newPersona.id === state.persona.id) {
            return JSON.stringify({ id: state.persona.id });
          }

          session.interrupt();
          const holdHandle = bgAudio.play({ source: holdBeats() });
          try {
            await actions.cancel();
            await state.avatar.aclose();
            state.avatar = makeAvatar(newPersona);
            state.sessionId = await state.avatar.start(session, ctx.room);
            session.updateAgent(makeAgent(newPersona, actions));
            state.persona = newPersona;
            await new Promise((resolve) => setTimeout(resolve, 1200));
          } finally {
            holdHandle.stop();
          }

          if (supportsActions(newPersona.id)) {
            actions.setSession(state.sessionId, newPersona.id);
            await actions.openingWave();
          }

          session.generateReply({
            instructions:
              `It's your turn to speak first. Open with a single short line in character as ${state.persona.name} ` +
              "(acknowledge that you're who they just picked) and then stop." +
              (supportsActions(newPersona.id) ? ' Do not call wave - you already waved.' : ''),
          });

          return JSON.stringify({ id: state.persona.id });
        } finally {
          switching = false;
        }
      },
    );
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
