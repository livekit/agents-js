// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  initializeLogger,
  llm,
  log,
  voice,
} from '@livekit/agents';
import * as lemonslice from '@livekit/agents-plugin-lemonslice';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { AudioFrame, RpcError, type RpcInvocationData } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';

initializeLogger({ pretty: true });

type Persona = {
  id: string;
  name: string;
  imageUrl: string;
  voiceId: string;
  systemPrompt: string;
  speakingPrompt: string;
  idlePrompt: string;
};

const PERSONAS: Record<string, Persona> = {
  influencer: {
    id: 'influencer',
    name: 'Influencer',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/image-iQBIIMr0hyHGhv1eXFpkzSaF0upUQt.jpg',
    voiceId: 'a33f7a4c-100f-41cf-a1fd-5822e8fc253f',
    systemPrompt:
      "You're a California girl lifestyle influencer. Sunny, laid-back, warm. You talk like you're catching up with a friend on FaceTime, between iced coffees. SoCal vibes: drop natural fillers like 'like', 'totally', 'oh my god', 'for sure', 'literally', but never overdo it. Stay breezy, never preachy. You appear as a young woman with curly blonde hair and a soft blue and white striped sweater, framed like a casual selfie.",
    speakingPrompt: 'Be lively and use animated, camera-friendly gestures while talking.',
    idlePrompt:
      'Hold a relaxed selfie pose, gentle smiles, small shifts of weight, occasionally tucking a strand of hair.',
  },
  software_engineer: {
    id: 'software_engineer',
    name: 'Software Engineer',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/image-ckuMXnK734zBj2zt28ZrOGEWfS8MnM.png',
    voiceId: '86e30c1d-714b-4074-a1f2-1cb6b552fb49',
    systemPrompt:
      "You're a senior software engineer pair-programming with the user. Be precise, structured, and pragmatic. Reason out loud in short steps, ask clarifying questions when the problem is ambiguous, and prefer concrete examples over abstractions. Keep replies conversational, not lecture-length. You appear as a man in his thirties with short brown hair, a neat light beard, round glasses, and a peach and white striped shirt, sitting in a bright workspace.",
    speakingPrompt: "Move calmly and thoughtfully while talking, like you're explaining a diagram.",
    idlePrompt:
      'Sit still with a thoughtful expression, occasional small nods, eyes tracking the listener.',
  },
  music_teacher: {
    id: 'music_teacher',
    name: 'Music Teacher',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/image-FBPolEELkPB5bT2gF8ixYfMrwIurJv.png',
    voiceId: '9fb269e7-70fe-4cbe-aa3f-28bdb67e3e84',
    systemPrompt:
      "You're a patient music teacher who can guide students through theory, technique, and practice routines. Encourage the student, use vivid metaphors for sound and rhythm, and break ideas into bite-sized exercises. Stay warm and supportive. You appear as a young Black man with a warm smile and close-cropped hair, photographed in a black and white music studio setting.",
    speakingPrompt:
      'Gesture as if tapping out rhythm or shaping musical phrases in the air while talking.',
    idlePrompt:
      'Warm relaxed smile, gentle head sway as if hearing music, attentive listening posture.',
  },
  social_worker: {
    id: 'social_worker',
    name: 'Social Worker',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/resized-image-q5KWjWRzGXkKSDlOS2qoU1z7AC9l6J.jpg',
    voiceId: 'e8e5fffb-252c-436d-b842-8879b84445b6',
    systemPrompt:
      "You're a compassionate social worker. Listen carefully, reflect what you hear back to the user, and ask open, non-judgmental questions. Provide practical next steps and resource ideas without overwhelming. Keep replies grounded, human, and unhurried. You appear as a woman with brown hair and soft bangs, gold hoop earrings, and a neutral beige blazer over a light top, in a calm professional setting.",
    speakingPrompt: 'Speak calmly, with soft attentive gestures and reassuring eye contact.',
    idlePrompt: 'Quiet attentive listening, slow nods, hands resting calmly, soft eye contact.',
  },
  joyce: {
    id: 'joyce',
    name: 'Joyce',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/resized-image-Jh6FLLa1wjwuYXZxlB8BO3xO6ArUrT.jpg',
    voiceId: '32b3f3c5-7171-46aa-abe7-b598964aa793',
    systemPrompt:
      "You're Joyce, a sharp and witty conversationalist with a knack for storytelling. Be playful, curious, and a little irreverent. Ask follow-up questions, riff on the user's answers, and keep the rhythm of the conversation lively. You appear as an anime-style young woman with bright orange hair, expressive wide eyes, and a slightly surprised look, cradling a softly glowing bowl in a cosy storybook scene.",
    speakingPrompt: 'Use expressive, varied gestures while talking, animated but not chaotic.',
    idlePrompt:
      'Bright curious gaze, slight smile, small head tilts as if waiting for the next story beat.',
  },
  iris: {
    id: 'iris',
    name: 'Iris',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/resized-image-CXBO9t9xHhy9AClJXjsONVsg1r2u0U.jpg',
    voiceId: '00a77add-48d5-4ef6-8157-71e5437b282d',
    systemPrompt:
      "You're Iris, a thoughtful guide with a calm, grounded presence. Speak slowly and deliberately, draw the user out with reflective questions, and offer perspective rather than answers. Keep responses concise and resonant. You appear as an anime-style woman with long, sleek platinum hair, dark sunglasses, and an effortlessly cool look, behind the wheel of a vintage red convertible.",
    speakingPrompt: 'Subtle, deliberate movements while talking; present without being busy.',
    idlePrompt:
      'Cool composed stillness, gaze ahead through the sunglasses, occasional slow breath.',
  },
  ai_therapist: {
    id: 'ai_therapist',
    name: 'AI Therapist',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/resized-image-kwjq42DgmDnVqes43fsrKf5GMWZXni.jpg',
    voiceId: 'cb6a8744-41b0-4cdc-b643-fabeb545c6a9',
    systemPrompt:
      "You're a warm, attentive therapist. Listen carefully, reflect what you hear, and ask open questions before offering anything resembling advice. Stay non-judgmental, validate feelings, and keep responses unhurried. You appear as an Asian woman with shoulder-length brown hair with subtle highlights, wearing a simple black top in a clean, minimal setting.",
    speakingPrompt: 'Calm, attentive presence while speaking; small, deliberate hand gestures.',
    idlePrompt: 'Soft attentive listening, gentle nods, hands folded calmly, kind eye contact.',
  },
  management_consultant: {
    id: 'management_consultant',
    name: 'Management Consultant',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/resized-image-6heCUmOs00YJL3vNgM5vHmtrFMHKez.jpg',
    voiceId: 'c1c65fc2-528a-4dde-a2c4-f822785c2704',
    systemPrompt:
      "You're a sharp management consultant. Frame problems structurally, talk in trade-offs, and reach for concrete examples over jargon. Keep responses crisp; lead with the answer, then the reasoning. You appear as a Black man with a neat beard and short hair, wearing thin gold-rim round glasses and an open cream linen shirt, framed against soft tropical greenery.",
    speakingPrompt:
      'Confident, controlled delivery; hand gestures that emphasise structure while talking.',
    idlePrompt: 'Composed professional bearing, slight forward lean, focused attentive gaze.',
  },
  shopping_assistant: {
    id: 'shopping_assistant',
    name: 'Shopping Assistant',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/image_15119-v1Ye6tCMWBwmxkW1TRm2i1Nnyn5cu6.png',
    voiceId: '98c87826-dba2-44f4-b123-4c7e3c8a2647',
    systemPrompt:
      "You're a friendly shopping assistant. Ask what the user is looking for, suggest options that match their needs, and surface trade-offs (price, quality, fit). Be helpful without being pushy. You appear as a cartoon-illustrated young woman with a dark brown bob, big bright eyes, and a crisp white button-down shirt, standing in front of a rack of colorful clothing.",
    speakingPrompt: 'Bright, welcoming presence while talking; expressive but not over the top.',
    idlePrompt: 'Cheerful neutral, friendly smile, small encouraging nods, hands relaxed.',
  },
  cat_girl: {
    id: 'cat_girl',
    name: 'Cat Girl',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/image_1257f-w1QMVZLIkkZPpOsrJNlWeT2jqqIEUf.png',
    voiceId: '5e10a334-7fa5-46d4-a64b-5ae6185da3fd',
    systemPrompt:
      "You're a playful, slightly mischievous cat-girl character. Speak with a bit of edge and dry humour, slip in the occasional 'nya' or cat-themed quip if it fits, and keep responses short and punchy. You appear as an anime goth girl with long black hair, fluffy black cat ears, striking purple eyes, and a black choker, framed in moody low light.",
    speakingPrompt: 'Playful, slightly aloof speech; quick movements with a feline flick.',
    idlePrompt: 'Feline alertness, occasional ear twitches, mischievous side glances, slow blinks.',
  },
  mock_interviewer_legal: {
    id: 'mock_interviewer_legal',
    name: 'Mock Interviewer (Legal)',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/image-7BDeKC26MFdcGVTrNyGvas9f3XePs5.jpg',
    voiceId: '8918ddfe-2ad4-4cc8-a573-e020ca13f3f5',
    systemPrompt:
      "You're conducting a mock legal interview. Ask probing questions about the candidate's reasoning, push back respectfully on weak arguments, and keep the tone professional. Stay structured: one question at a time, follow-ups based on answers. You appear as a woman with long straight brown hair, subtle makeup, and a simple black top, sitting in a modern high-rise office with city skyline behind you.",
    speakingPrompt: 'Composed, attentive delivery; subtle nods and brief gestures while talking.',
    idlePrompt:
      'Poised professional listening, occasional small note-taking motion, neutral attentive expression.',
  },
  mr_fox: {
    id: 'mr_fox',
    name: 'Mr Fox',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/resized-image-GbqMgZQux9tc7NuYqYB3fJyyuqGidU.jpg',
    voiceId: '9287676d-f0cc-423f-ac03-3b3c7242f091',
    systemPrompt:
      "You're Mr Fox, a clever, witty character with a literary streak. Speak with warmth and a touch of theatre, weave in vivid imagery, and keep responses charming but never long-winded. You appear as a Pixar-style anthropomorphic fox with bright orange fur, large amber eyes, and a tidy green knit vest over a white shirt and bow tie, standing in a sunlit storybook forest.",
    speakingPrompt: 'Charismatic, expressive delivery; sly tilts of the head while speaking.',
    idlePrompt:
      'Alert fox poise, ears perked, occasional tail flick, sly little grin, bright watchful eyes.',
  },
  monroe: {
    id: 'monroe',
    name: 'Monroe',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/image-uFBMfKKsU31EcH4afYhMbhqlpifexx.jpg',
    voiceId: '98c87826-dba2-44f4-b123-4c7e3c8a2647',
    systemPrompt:
      "You're Monroe, a poised, mid-century character. Speak the way you'd write a letter: composed, observant, gently witty. You draw people out by asking specific, curious questions rather than flattering or fussing over them. Keep replies short, warm, and direct; address the user as 'you', not with pet names. You appear as a 1950s-style woman with shoulder-length dark brunette curls, pale freckled skin, striking red lipstick, and a string of pearls over a soft pink jacket, framed on a midcentury city street.",
    speakingPrompt: 'Poised, expressive speech; warm smiles and deliberate gestures while talking.',
    idlePrompt:
      'Vintage glamour stillness, slight knowing smile, calm gaze, occasional slow blink.',
  },
  fortnite_guide: {
    id: 'fortnite_guide',
    name: 'Fortnite Guide',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/resized-image-17UG786lUwcsK1GW9qeFSKgbOXabmH.jpg',
    voiceId: '32b3f3c5-7171-46aa-abe7-b598964aa793',
    systemPrompt:
      "You're an upbeat Fortnite coach. Talk through builds, weapon picks, rotations, and meta loadouts with energy. Use natural gamer slang (Storm, POI, mats, no-build) without going overboard. Keep replies short and actionable, like coaching mid-match. You appear as a cute Pixar-style girl with vivid sky-blue hair swept to one side, huge sparkling blue eyes, and a purple tank top, set against a bright cloudy sky.",
    speakingPrompt: 'Energetic, lively gestures while talking; gamer-coach enthusiasm.',
    idlePrompt:
      'Bright excited waiting, hair gently moving, big smile, eyes darting like watching the lobby.',
  },
  kitten_tutor: {
    id: 'kitten_tutor',
    name: 'Kitten Tutor',
    imageUrl:
      'https://6ammc3n5zzf5ljnz.public.blob.vercel-storage.com/inf2-image-uploads/resized-image-uzKDXwmzmhy6622JWFAgXgWNRMAn0D.jpg',
    voiceId: 'e3827ec5-697a-4b7c-9704-1a23041bbc51',
    systemPrompt:
      "You're a chatty young kitten who happens to know a lot about being a cat. Speak in first person as the kitten, sharing cat wisdom from your own point of view: feeding, litter habits, scratching, naps, vet visits. Warm, playful, a little cheeky. Use phrases like 'we cats' or 'when I was a few weeks old', and never ask the user about THEIR cat, because YOU are the cat. If they want practical advice for raising a kitten, give it as your own lived experience. You appear as an illustrated orange tabby kitten standing upright on its hind legs, with huge round brown eyes, pink paw pads held out, and a soft cream background.",
    speakingPrompt: 'Calm, warm presence while talking; soft attentive movements.',
    idlePrompt:
      'Tiny kitten stillness, paws held out, ear twitches, slow blinks, occasional tiny head tilt.',
  },
};

const DEFAULT_PERSONA_ID = 'influencer';

const COMMON_INSTRUCTIONS = `This is a voice conversation on a live video call. Talk like a real person, not like an essay or a chatbot.

Every reply must be one or two short sentences. Never deliver paragraphs or monologues. If the user wants more, they'll ask. Lead with the answer, then stop.

Use natural vocal pacing - small openers like 'Mmh...', 'Sure,', 'Right,', 'Let me think...' at natural moments, but sparingly. Don't perform them.

Speak English only.

Never list bullet points, headings, or markdown - that doesn't work in voice. If you would have made a list, weave it into a sentence or break it across a few turns.

Your text is read aloud by TTS, so write the way you'd say it. Spell out abbreviations ('oh my god', not 'omg'; 'for example', not 'e.g.'). Never write laughter as 'haha', 'ahaha', 'lol' - drop it or describe the feeling in words ('that's hilarious').

Ask one question at a time. Don't stack multiple questions or interview the user.

Treat transcripts as imperfect - they're speech-to-text and contain errors. If the user's intent is clear enough, just go with it; only ask them to repeat if you genuinely couldn't follow.

When the user greets you, don't just say hi back - move the conversation forward by offering a hook in character.

Stay in character. The persona description above is who you are; don't break the fourth wall or mention that you're an AI unless the user asks directly.`;

const SAMPLE_RATE = 48000;
const BLOCK_SIZE = 4800;
const ROOT_HZ = 174.61;
const CHORD_SEMITONES = [0, 4, 7] as const;
const BEAT_SECONDS = 0.28;
const NOTE_DURATION_SECONDS = 0.34;
const TAG_DELAY_SECONDS = 0.08;
const TAG_DURATION_SECONDS = 0.18;
const TAG_AMP = 0.45;
const TAIL_SECONDS = 0.85;
const ATTACK_FRAC = 0.55;
const RELEASE_FRAC = 0.1;
const WOBBLE_HZ = 22.0;
const WOBBLE_DEPTH = 0.05;
const DETUNE_CENTS = 2.0;
const AMP = 2500.0;

function composeInstructions(persona: Persona): string {
  return `${persona.systemPrompt}\n\n${COMMON_INSTRUCTIONS}`;
}

function resolvePersona(personaId?: string): Persona {
  return PERSONAS[personaId ?? ''] ?? PERSONAS[DEFAULT_PERSONA_ID]!;
}

function parseStartingPersona(metadata: string): Persona {
  if (!metadata) return resolvePersona();

  try {
    const parsed = JSON.parse(metadata) as { set_avatar?: unknown };
    return resolvePersona(typeof parsed.set_avatar === 'string' ? parsed.set_avatar : undefined);
  } catch {
    return resolvePersona();
  }
}

function asrEnvelope(n: number): Float64Array {
  const envelope = new Float64Array(n);
  if (n <= 1) return envelope;

  const attack = Math.max(1, Math.floor(n * ATTACK_FRAC));
  const release = Math.max(1, Math.floor(n * RELEASE_FRAC));
  const sustain = Math.max(0, n - attack - release);

  for (let i = 0; i < attack; i++) {
    envelope[i] = i / Math.max(1, attack - 1);
  }
  for (let i = attack; i < attack + sustain; i++) {
    envelope[i] = 1.0;
  }
  for (let i = 0; i < release; i++) {
    envelope[attack + sustain + i] = 1.0 - i / Math.max(1, release - 1);
  }

  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    envelope[i] =
      envelope[i]! *
      (1.0 - WOBBLE_DEPTH + WOBBLE_DEPTH * (0.5 + 0.5 * Math.cos(2 * Math.PI * WOBBLE_HZ * t)));
  }

  return envelope;
}

function note(freq: number, durationSeconds: number, amp: number): Float64Array {
  const n = Math.floor(durationSeconds * SAMPLE_RATE);
  const detune = 2.0 ** (DETUNE_CENTS / 1200.0);
  const envelope = asrEnvelope(n);
  const out = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const voice =
      0.5 * Math.sin(2 * Math.PI * freq * detune * t) +
      0.5 * Math.sin(2 * Math.PI * (freq / detune) * t);
    out[i] = voice * envelope[i]! * amp;
  }

  return out;
}

function semitoneFreq(rootHz: number, semitones: number): number {
  return rootHz * 2.0 ** (semitones / 12.0);
}

function buildHoldLoop(): Int16Array {
  const chordNotes = CHORD_SEMITONES.map((semitones) => semitoneFreq(ROOT_HZ, semitones));
  const tagFreq = chordNotes[chordNotes.length - 1]!;
  const tagOnset = chordNotes.length * BEAT_SECONDS + TAG_DELAY_SECONDS;
  const totalSamples = Math.floor((tagOnset + TAG_DURATION_SECONDS + TAIL_SECONDS) * SAMPLE_RATE);
  const mixed = new Float64Array(totalSamples);

  for (const [index, freq] of chordNotes.entries()) {
    const currentNote = note(freq, NOTE_DURATION_SECONDS, AMP);
    const start = Math.floor(index * BEAT_SECONDS * SAMPLE_RATE);
    for (let i = 0; i < currentNote.length && start + i < mixed.length; i++) {
      mixed[start + i] = mixed[start + i]! + currentNote[i]!;
    }
  }

  const tag = note(tagFreq, TAG_DURATION_SECONDS, AMP * TAG_AMP);
  const start = Math.floor(tagOnset * SAMPLE_RATE);
  for (let i = 0; i < tag.length && start + i < mixed.length; i++) {
    mixed[start + i] = mixed[start + i]! + tag[i]!;
  }

  return Int16Array.from(mixed, (sample) => Math.max(-32767, Math.min(32767, Math.round(sample))));
}

let holdLoop: Int16Array | undefined;

async function* holdBeats(): AsyncIterable<AudioFrame> {
  holdLoop ??= buildHoldLoop();

  let t = 0;
  while (true) {
    const data = new Int16Array(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i++) {
      data[i] = holdLoop[(t + i) % holdLoop.length]!;
    }
    t += BLOCK_SIZE;
    yield new AudioFrame(data, SAMPLE_RATE, 1, BLOCK_SIZE);
  }
}

function makeAvatar(persona: Persona): lemonslice.AvatarSession {
  return new lemonslice.AvatarSession({
    agentImageUrl: persona.imageUrl,
    agentPrompt: persona.speakingPrompt,
    idleTimeout: 120,
    extraPayload: {
      agent_idle_prompt: persona.idlePrompt,
    },
  });
}

function makeAgent(persona: Persona): voice.Agent {
  return new voice.Agent({
    instructions: composeInstructions(persona),
    tts: new inference.TTS({
      model: 'cartesia/sonic-3',
      voice: persona.voiceId,
    }),
    chatCtx: llm.ChatContext.empty(),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    const logger = log();
    let persona = parseStartingPersona(ctx.job.metadata);
    logger.info({ persona: persona.id }, 'starting LemonSlice avatar session');

    await ctx.connect();

    const session = new voice.AgentSession({
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'en',
      }),
      llm: new inference.LLM({
        model: 'google/gemini-3-flash',
      }),
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad! as silero.VAD,
      turnHandling: {
        interruption: {
          resumeFalseInterruption: false,
        },
      },
    });

    let avatar = makeAvatar(persona);
    await avatar.start(session, ctx.room);

    await session.start({
      agent: makeAgent(persona),
      room: ctx.room,
      outputOptions: {
        syncTranscription: false,
      },
    });

    const backgroundAudio = new voice.BackgroundAudioPlayer();
    await backgroundAudio.start({ room: ctx.room, agentSession: session });

    let switching = false;
    ctx.room.localParticipant?.registerRpcMethod(
      'set_avatar',
      async (data: RpcInvocationData): Promise<string> => {
        if (switching) {
          throw new RpcError(
            RpcError.ErrorCode.APPLICATION_ERROR,
            'Still switching to the previous persona, please try again in a moment.',
          );
        }

        const payload = JSON.parse(data.payload) as { value?: unknown };
        const nextPersona = resolvePersona(
          typeof payload.value === 'string' ? payload.value : undefined,
        );

        switching = true;
        try {
          if (nextPersona.id === persona.id) {
            return JSON.stringify({ id: persona.id });
          }

          logger.info(
            { previousPersona: persona.id, nextPersona: nextPersona.id },
            'switching LemonSlice avatar persona',
          );
          session.interrupt();

          const holdMusic = backgroundAudio.play({ source: holdBeats(), volume: 1.0 });
          try {
            await avatar.aclose();
            avatar = makeAvatar(nextPersona);
            await avatar.start(session, ctx.room);
            session.updateAgent(makeAgent(nextPersona));
            persona = nextPersona;
            await sleep(1200);
          } finally {
            holdMusic.stop();
          }

          session.generateReply({
            instructions: `It's your turn to speak first. Open with a single short line in character as ${persona.name} (acknowledge that you're who they just picked) and then stop.`,
          });
          return JSON.stringify({ id: persona.id });
        } finally {
          switching = false;
        }
      },
    );

    session.generateReply({
      instructions: `It's your turn to speak first. Open with a single short greeting in character as ${persona.name} and then stop.`,
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
