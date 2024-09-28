// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, multimodal } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import type {
  LocalParticipant,
  Participant,
  RemoteParticipant,
  TrackPublication,
} from '@livekit/rtc-node';
import { RemoteTrackPublication, TrackSource } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // console.log(`connecting to room ${ctx.room.name}`);
    console.log('Connecting to room...');
    await ctx.connect();
    console.log('Connected to room successfully');

    console.log('Waiting for participant...');
    const participant = await ctx.waitForParticipant();
    console.log(`Participant ${participant.identity} joined`);

    console.log('Starting multimodal agent...');
    await runMultimodalAgent(ctx, participant);
    console.log('Multimodal agent started successfully');

    console.log('Agent initialization complete');
  },
});

interface SessionConfig {
  openaiApiKey: string;
  instructions: string;
  voice: string;
  temperature: number;
  maxOutputTokens?: number;
  modalities: string[];
}

function parseSessionConfig(data: any): SessionConfig {
  return {
    openaiApiKey: data.openai_api_key || '',
    instructions: data.instructions || '',
    voice: data.voice || '',
    temperature: parseFloat(data.temperature || '0.8'),
    maxOutputTokens: data.max_output_tokens || undefined,
    modalities: modalitiesFromString(data.modalities || 'text_and_audio'),
  };
}

function modalitiesFromString(modalities: string): ['text', 'audio'] | ['text'] {
  const modalitiesMap: { [key: string]: ['text', 'audio'] | ['text'] } = {
    text_and_audio: ['text', 'audio'],
    text_only: ['text'],
  };
  return modalitiesMap[modalities] || ['text', 'audio'];
}

function getMicrophoneTrackSid(participant: Participant): string | undefined {
  return Array.from(participant.trackPublications.values()).find(
    (track: TrackPublication) => track.source === TrackSource.SOURCE_MICROPHONE,
  )?.sid;
}

async function runMultimodalAgent(ctx: JobContext, participant: RemoteParticipant) {
  const metadata = JSON.parse(participant.metadata);
  const config = parseSessionConfig(metadata);
  console.log(`starting multimodal agent with config: ${JSON.stringify(config)}`);

  const model = new openai.realtime.RealtimeModel({
    apiKey: config.openaiApiKey,
    instructions: config.instructions,
    voice: config.voice,
    temperature: config.temperature,
    maxResponseOutputTokens: config.maxOutputTokens,
    modalities: config.modalities as ['text', 'audio'] | ['text'],
  });

  const agent = new multimodal.MultimodalAgent({ model });
  const session = (await agent.start(ctx.room)) as openai.realtime.RealtimeSession;

  session.defaultConversation.item.create({
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: 'Please begin the interaction with the user in a manner consistent with your instructions.',
      },
    ],
  });
  session.response.create();

  ctx.room.on(
    'participantAttributesChanged',
    (changedAttributes: Record<string, string>, participant: Participant) => {
      const newConfig = parseSessionConfig({ ...participant.attributes, ...changedAttributes });
      console.log(`participant attributes changed: ${JSON.stringify(newConfig)}`);

      session.sessionUpdate({
        instructions: newConfig.instructions,
        temperature: newConfig.temperature,
        maxResponseOutputTokens: newConfig.maxOutputTokens,
        modalities: newConfig.modalities as ['text', 'audio'] | ['text'],
        // voice: newConfig.voice,
        // inputAudioFormat: 'pcm16',
        // outputAudioFormat: 'pcm16',
        // turnDetection: 'auto',
        // toolChoice: 'auto',
      });

      if ('instructions' in changedAttributes) {
        session.defaultConversation.item.create({
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Your instructions have changed. Please acknowledge this in a manner consistent with your new instructions. Do not explicitly mention the change in instructions.',
            },
          ],
        });
      }
      session.response.create();
    },
  );

  let lastTranscriptId: string | null = null;

  async function sendTranscription(
    ctx: JobContext,
    participant: Participant,
    trackSid: string,
    segmentId: string,
    text: string,
    isFinal: boolean = true,
  ) {
    const transcription = {
      participantIdentity: participant.identity,
      trackSid: trackSid,
      segments: [
        {
          id: segmentId,
          text: text,
          startTime: BigInt(0),
          endTime: BigInt(0),
          language: '',
          final: isFinal,
        },
      ],
    };
    await (ctx.room.localParticipant as LocalParticipant).publishTranscription(transcription);
  }

  session.on('response_done', (response: openai.realtime.RealtimeResponse) => {
    let message: string | undefined;
    if (response.status === 'incomplete') {
      message = '🚫 response incomplete';
    } else if (response.status === 'failed') {
      message = '⚠️ response failed';
    } else {
      return;
    }

    const localParticipant = ctx.room.localParticipant as LocalParticipant;
    const trackSid = getMicrophoneTrackSid(localParticipant);

    if (trackSid) {
      sendTranscription(ctx, localParticipant, trackSid, uuidv4(), message);
    }
  });

  session.on('input_speech_started', () => {
    const remoteParticipant = Object.values(ctx.room.remoteParticipants)[0];
    if (!remoteParticipant) return;

    const trackSid = getMicrophoneTrackSid(remoteParticipant);

    if (trackSid) {
      if (lastTranscriptId) {
        sendTranscription(ctx, remoteParticipant, trackSid, lastTranscriptId, '');
      }

      const newId = uuidv4();
      lastTranscriptId = newId;
      sendTranscription(ctx, remoteParticipant, trackSid, newId, '…', false);
    }
  });

  session.on(
    'input_speech_transcription_completed',
    (event: openai.realtime.InputSpeechTranscriptionCompleted) => {
      if (lastTranscriptId) {
        const remoteParticipant = Object.values(ctx.room.remoteParticipants)[0];
        if (!remoteParticipant) return;

        const trackSid = getMicrophoneTrackSid(remoteParticipant);

        if (trackSid) {
          sendTranscription(ctx, remoteParticipant, trackSid, lastTranscriptId, '');
          lastTranscriptId = null;
        }
      }
    },
  );

  session.on(
    'input_speech_transcription_failed',
    (event: openai.realtime.InputSpeechTranscriptionFailed) => {
      if (lastTranscriptId) {
        const remoteParticipant = Object.values(ctx.room.remoteParticipants)[0];
        if (!remoteParticipant) return;

        const trackSid = getMicrophoneTrackSid(remoteParticipant);

        if (trackSid) {
          const errorMessage = '⚠️ Transcription failed';
          sendTranscription(ctx, remoteParticipant, trackSid, lastTranscriptId, errorMessage);
          lastTranscriptId = null;
        }
      }
    },
  );
}

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
