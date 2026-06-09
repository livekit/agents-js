// SPDX-FileCopyrightText: 2026 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Scratch agent for exercising `lk agent console` / `lk agent dev` against the
// Node SDK without any model-provider credentials: a FakeSTT scripts one user
// turn, a FakeLLM answers from a lookup table, and a ToneTTS synthesizes a
// sine tone so the audio path is audible end to end.
import {
  type APIConnectOptions,
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  stt as sttlib,
  tts as ttslib,
  voice,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 24000;
const TONE_HZ = 440;

function* toneFrames(durationMs: number): Generator<AudioFrame> {
  const total = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const chunk = SAMPLE_RATE / 10; // 100ms frames
  let emitted = 0;
  while (emitted < total) {
    const n = Math.min(chunk, total - emitted);
    const samples = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      samples[i] = Math.round(
        8000 * Math.sin((2 * Math.PI * TONE_HZ * (emitted + i)) / SAMPLE_RATE),
      );
    }
    emitted += n;
    yield new AudioFrame(samples, SAMPLE_RATE, 1, n);
  }
}

class ToneSynthesizeStream extends ttslib.SynthesizeStream {
  label = 'tone.SynthesizeStream';

  protected async run(): Promise<void> {
    const requestId = 'tone-req';
    let pending = '';
    let segment = 0;
    for await (const data of this.input) {
      if (data === ttslib.SynthesizeStream.FLUSH_SENTINEL) {
        if (pending.trim().length > 0) {
          const segmentId = `tone-seg-${segment++}`;
          const durationMs = Math.min(2000, Math.max(400, pending.length * 30));
          let lastFrame: AudioFrame | undefined;
          for (const frame of toneFrames(durationMs)) {
            if (lastFrame) this.queue.put({ requestId, segmentId, frame: lastFrame, final: false });
            lastFrame = frame;
          }
          if (lastFrame) this.queue.put({ requestId, segmentId, frame: lastFrame, final: true });
          this.queue.put(ttslib.SynthesizeStream.END_OF_STREAM);
        }
        pending = '';
        continue;
      }
      pending += data;
    }
  }
}

class ToneChunkedStream extends ttslib.ChunkedStream {
  label = 'tone.ChunkedStream';

  constructor(text: string, tts: ToneTTS, connOptions?: APIConnectOptions) {
    super(text, tts, connOptions);
  }

  protected async run(): Promise<void> {
    let lastFrame: AudioFrame | undefined;
    for (const frame of toneFrames(800)) {
      if (lastFrame)
        this.queue.put({
          requestId: 'tone-req',
          segmentId: 'tone-seg',
          frame: lastFrame,
          final: false,
        });
      lastFrame = frame;
    }
    if (lastFrame)
      this.queue.put({
        requestId: 'tone-req',
        segmentId: 'tone-seg',
        frame: lastFrame,
        final: true,
      });
  }
}

class ToneTTS extends ttslib.TTS {
  label = 'tone-tts';

  constructor() {
    super(SAMPLE_RATE, 1, { streaming: true });
  }

  synthesize(text: string, connOptions?: APIConnectOptions): ttslib.ChunkedStream {
    return new ToneChunkedStream(text, this, connOptions);
  }

  stream(options?: { connOptions?: APIConnectOptions }): ttslib.SynthesizeStream {
    return new ToneSynthesizeStream(this, options?.connOptions);
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      stt: new sttlib.testing.FakeSTT({
        fakeUserSpeeches: [
          { startTime: 1500, endTime: 3000, transcript: 'hello agent', sttDelay: 200 },
        ],
      }),
      llm: new voice.testing.FakeLLM([
        {
          input: 'hello agent',
          content: 'Hi! I hear you loud and clear. This is the JS console test agent.',
        },
        { input: 'how are you', content: 'Doing great. All systems nominal.' },
      ]),
      tts: new ToneTTS(),
    });

    await session.start({
      agent: new voice.Agent({ instructions: 'You are a test agent.' }),
      room: ctx.room,
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
