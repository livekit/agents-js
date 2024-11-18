// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { type JobContext, WorkerOptions, cli, defineAgent, stt } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-deepgram';
import type { Track } from '@livekit/rtc-node';
import { AudioStream, RoomEvent, TrackKind } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log('starting STT example agent');

    const transcribeTrack = async (track: Track) => {
      const audioStream = new AudioStream(track);
      const sttStream = new STT({ sampleRate: 48000 }).stream();

      const sendTask = async () => {
        for await (const event of audioStream) {
          sttStream.pushFrame(event);
        }
      };

      const recvTask = async () => {
        for await (const event of sttStream) {
          if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT) {
            console.log(event.alternatives![0].text);
          }
        }
      };

      Promise.all([sendTask(), recvTask()]);
    };

    ctx.room.on(RoomEvent.TrackSubscribed, async (track: Track) => {
      if (track.kind === TrackKind.KIND_AUDIO) {
        transcribeTrack(track);
      }
    });
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
