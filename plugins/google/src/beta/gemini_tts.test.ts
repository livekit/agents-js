// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { tts as agentsTts, tokenize } from '@livekit/agents';
import { STT } from '@livekit/agents-plugin-openai';
import { tts } from '@livekit/agents-plugins-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TTS } from './gemini_tts.js';

const { generateContentStream } = vi.hoisted(() => ({
  generateContentStream: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function GoogleGenAI() {
    return {
      models: {
        generateContentStream,
      },
    };
  }),
}));

describe('Google Gemini TTS integration', () => {
  it.skip('synthesizes with live providers', async () => {
    await tts(new TTS(), new STT());
  });
});

describe('Google Gemini TTS', () => {
  it('synthesizes audio from a streamed Gemini response', async () => {
    const audioChunk = Buffer.alloc(4800);

    generateContentStream.mockImplementation(async function* () {
      yield buildResponseChunk(audioChunk);
      yield buildResponseChunk(audioChunk);
    });

    const stream = new TTS({ apiKey: 'test-api-key' }).synthesize('Hello world');
    let audioCount = 0;

    for await (const _frame of stream) {
      audioCount += 1;
    }

    expect(generateContentStream).toHaveBeenCalledOnce();
    expect(audioCount).toBeGreaterThan(0);
  });
});

type RequestArgs = {
  contents: unknown;
  config: {
    speechConfig?: {
      voiceConfig?: unknown;
      multiSpeakerVoiceConfig?: { speakerVoiceConfigs: { speaker: string }[] };
    };
    httpOptions?: { extraBody?: Record<string, unknown> };
  };
};

/** The last request's arguments. */
function lastRequest(): RequestArgs {
  return generateContentStream.mock.lastCall![0] as RequestArgs;
}

/** The contents the SDK will actually send, after extraBody is merged in. */
function sentContents(): unknown {
  const { contents, config } = lastRequest();
  return config.httpOptions?.extraBody?.contents ?? contents;
}

async function synthesize(tts: TTS, text: string): Promise<void> {
  for await (const _frame of tts.synthesize(text)) {
    // drain
  }
}

describe('Google Gemini TTS expressive markup', () => {
  beforeEach(() => {
    generateContentStream.mockReset();
    generateContentStream.mockImplementation(async function* () {
      yield buildResponseChunk(Buffer.alloc(4800));
    });
  });

  it('declares the dialect only on the models that style per part', () => {
    // only a model that can carry a style out of band may declare the dialect
    for (const model of ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']) {
      expect(new TTS({ apiKey: 'k', model }).markup.providerKey).toBe('gemini');
    }
    // `model` is typed `| string`: a dated build of one still counts
    const dated = new TTS({ apiKey: 'k', model: 'gemini-3.8-flash-tts-preview-09-2026' });
    expect(dated.markup.providerKey).toBe('gemini');
    expect(dated.markup.llmInstructions()).toBeDefined();

    const older = new TTS({ apiKey: 'k', model: 'gemini-2.5-flash-tts' });
    expect(older.markup.providerKey).toBe('');
    expect(older.markup.llmInstructions()).toBeUndefined();
  });

  it.each(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'])(
    'turns expressive markup into speech_metadata for %s',
    async (model) => {
      await synthesize(
        new TTS({ apiKey: 'k', model }),
        '<expr type="expression" label="Thoughtful, Quiet, American accent"/> Sienna?',
      );
      expect(sentContents()).toEqual([
        {
          role: 'user',
          parts: [
            {
              text: '"Sienna?"',
              speech_metadata: { style: 'Thoughtful, Quiet, American accent' },
            },
          ],
        },
      ]);
    },
  );

  it('keeps the plain prompt for unmarked text', async () => {
    await synthesize(new TTS({ apiKey: 'k', model: 'gemini-3.8-flash-tts' }), 'Hello world');
    // nothing to style, so contents is left alone and the words go as they are
    expect(lastRequest().config.httpOptions?.extraBody?.contents).toBeUndefined();
    expect(lastRequest().contents).toEqual([{ role: 'user', parts: [{ text: 'Hello world' }] }]);
  });

  it('receives markers through the stream adapter', async () => {
    // Gemini TTS isn't streaming, so the agent drives it through tts.StreamAdapter, which
    // is where the framework lowers markup for a plugin
    const geminiTts = new TTS({ apiKey: 'k', model: 'gemini-3.8-flash-tts' });
    geminiTts._setExpressive(true); // the pipeline does this just before stream()
    const adapter = new agentsTts.StreamAdapter(
      geminiTts,
      new tokenize.basic.SentenceTokenizer({ xmlAware: true }),
    );
    expect(adapter.markup.providerKey).toBe('gemini');

    const stream = adapter.stream();
    // split mid-marker, the way tokens actually arrive from an LLM
    for (const chunk of ['<expr type="expression" label="Warm, ', 'Welcoming"/> Hey there.']) {
      stream.pushText(chunk);
    }
    stream.endInput();
    for await (const ev of stream) {
      if (ev === agentsTts.SynthesizeStream.END_OF_STREAM) break;
    }
    await adapter.close();

    expect(sentContents()).toEqual([
      {
        role: 'user',
        parts: [{ text: '"Hey there."', speech_metadata: { style: 'Warm, Welcoming' } }],
      },
    ]);
  });

  it('puts instructions in the style, not the spoken text', async () => {
    // a preamble in a part's text is read out loud by this family (measured: prefixing
    // "Say the text with a proper tone..." roughly tripled a short sentence)
    expect(new TTS({ apiKey: 'k', model: 'gemini-3.8-flash-tts' }).opts.instructions).toBe(
      undefined,
    );
    expect(new TTS({ apiKey: 'k', model: 'gemini-2.5-flash-tts' }).opts.instructions).toBeDefined();

    await synthesize(
      new TTS({ apiKey: 'k', model: 'gemini-3.8-flash-tts', instructions: 'Speak slowly' }),
      '<expr type="expression" label="Wistful"/> Sienna?',
    );
    expect(sentContents()).toEqual([
      {
        role: 'user',
        parts: [{ text: '"Sienna?"', speech_metadata: { style: 'Speak slowly, Wistful' } }],
      },
    ]);
  });

  it('keeps inline events in the words', async () => {
    // an inline tag in the style field does nothing; a style label left in the text is read
    // out loud. Raw expr markers, as a direct synthesize() call gets them: the plugin lowers
    // the sound itself rather than relying on the stream adapter having done it
    await synthesize(
      new TTS({ apiKey: 'k', model: 'gemini-3.8-flash-tts' }),
      '<expr type="expression" label="Easygoing, Warm"/> Yeah, ' +
        '<expr type="sound" label="chuckle"/> I get that a lot.',
    );
    expect(sentContents()).toEqual([
      {
        role: 'user',
        parts: [
          {
            text: '"Yeah, <chuckle> I get that a lot."',
            speech_metadata: { style: 'Easygoing, Warm' },
          },
        ],
      },
    ]);
  });

  it('asks for headerless PCM explicitly', async () => {
    // the byte stream is decoded as raw PCM, and the docs only guarantee a headerless
    // stream when response_format names it
    await synthesize(new TTS({ apiKey: 'k', model: 'gemini-3.8-flash-tts' }), 'Hello world');
    expect(lastRequest().config.httpOptions?.extraBody?.generationConfig).toEqual({
      response_format: { audio: { mime_type: 'AUDIO_L16' } },
    });
  });

  it('gives each styled sentence its own part', async () => {
    // Gemini takes a style per part, so a style change has to open a new one; folding
    // several styled sentences into one part would speak the later ones with the first
    // one's delivery
    await synthesize(
      new TTS({ apiKey: 'k', model: 'gemini-3.8-flash-tts' }),
      '<expr type="expression" label="Warm"/> Hello. ' +
        '<expr type="expression" label="Sad"/> <expr type="sound" label="sigh"/> Goodbye.',
    );
    expect(sentContents()).toEqual([
      {
        role: 'user',
        parts: [
          { text: '"Hello."', speech_metadata: { style: 'Warm' } },
          // the inline event stays in the words it belongs to
          { text: '"<sigh> Goodbye."', speech_metadata: { style: 'Sad' } },
        ],
      },
    ]);
  });

  it('does not let an unstyled span sink the request', async () => {
    // abandoning the parts would fall back to the raw text, and since gemini conversion
    // deliberately leaves expression markers standing, Gemini would read them aloud
    await synthesize(
      new TTS({ apiKey: 'k', model: 'gemini-3.8-flash-tts' }),
      'Hello. <expr type="expression" label="Sad"/> Goodbye.',
    );
    expect(sentContents()).toEqual([
      {
        role: 'user',
        parts: [
          { text: '"Hello."' }, // no direction of its own, and no metadata key
          { text: '"Goodbye."', speech_metadata: { style: 'Sad' } },
        ],
      },
    ]);
  });
});

describe('Google Gemini TTS lowered markup', () => {
  beforeEach(() => {
    generateContentStream.mockReset();
    generateContentStream.mockImplementation(async function* () {
      yield buildResponseChunk(Buffer.alloc(4800));
    });
  });

  it.each([
    ['Hello <expr type="sound" label="laugh"/> there.', '"Hello <laugh> there."'],
    ['Hello <expr type="break" label="300ms"/> there.', '"Hello <short pause> there."'],
    ['Say <expr type="prosody" label="emphasis">this</expr> now.', '"Say THIS now."'],
  ])('sends lowered markup even without a style: %s', async (written, spoken) => {
    // conversion happens here, so these parts are the only copy of its result. A direct
    // synthesize() gets text the stream adapter never lowered; falling back to the plain
    // prompt would send the raw input and let Gemini read the markup out loud
    await synthesize(new TTS({ apiKey: 'k', model: 'gemini-3.8-flash-tts' }), written);
    // no style to carry, so no speech_metadata — but the lowered words still travel
    expect(sentContents()).toEqual([{ role: 'user', parts: [{ text: spoken }] }]);
  });
});

describe('Google Gemini TTS multi-speaker', () => {
  const speakers = { Sienna: 'Kore', Comanchero: 'Puck' };

  beforeEach(() => {
    generateContentStream.mockReset();
    generateContentStream.mockImplementation(async function* () {
      yield buildResponseChunk(Buffer.alloc(4800));
    });
  });

  it('validates the config', () => {
    const model = 'gemini-3.8-flash-tts';
    // a multi-speaker turn whose speech_metadata names no speaker is rejected by the API,
    // so there is no useful default to fall back to
    expect(() => new TTS({ apiKey: 'k', model, speakers })).toThrow('`speaker` is required');

    // the API rejects any count but two — a single speaker, and an empty table that would
    // otherwise slip past into the single-voice config
    const bad: Record<string, string>[] = [
      {},
      { Solo: 'Kore' },
      { A: 'Kore', B: 'Puck', C: 'Charon' },
    ];
    for (const speakersTable of bad) {
      expect(() => new TTS({ apiKey: 'k', model, speakers: speakersTable, speaker: 'A' })).toThrow(
        'exactly 2 speakers',
      );
    }

    expect(() => new TTS({ apiKey: 'k', model, speakers, speaker: 'Nobody' })).toThrow(
      'not one of the configured speakers',
    );
    // only configured names count, not members every object inherits
    expect(() => new TTS({ apiKey: 'k', model, speakers, speaker: 'toString' })).toThrow(
      'not one of the configured speakers',
    );

    // the speaker travels in speech_metadata, which the older models have no field for
    expect(
      () => new TTS({ apiKey: 'k', model: 'gemini-2.5-flash-tts', speakers, speaker: 'Sienna' }),
    ).toThrow('per-part speech_metadata');

    const geminiTts = new TTS({ apiKey: 'k', model, speakers, speaker: 'Sienna' });
    geminiTts.updateOptions({ speaker: 'Comanchero' });
    expect(geminiTts.opts.speaker).toBe('Comanchero');
    expect(() => geminiTts.updateOptions({ speaker: 'Nobody' })).toThrow(
      'not one of the configured speakers',
    );
    expect(() => new TTS({ apiKey: 'k', model }).updateOptions({ speaker: 'Sienna' })).toThrow(
      'needs a TTS constructed with `speakers`',
    );
  });

  it('names the speaker on every turn', async () => {
    // plain words, no markers: the part is still sent, because the speaker has to travel
    await synthesize(
      new TTS({ apiKey: 'k', model: 'gemini-3.8-flash-tts', speakers, speaker: 'Sienna' }),
      'Sienna?',
    );
    expect(sentContents()).toEqual([
      { role: 'user', parts: [{ text: '"Sienna?"', speech_metadata: { speaker: 'Sienna' } }] },
    ]);

    const speech = lastRequest().config.speechConfig!;
    expect(speech.voiceConfig).toBeUndefined();
    expect(speech.multiSpeakerVoiceConfig!.speakerVoiceConfigs.map((c) => c.speaker)).toEqual([
      'Sienna',
      'Comanchero',
    ]);
  });

  it('keeps the speaker an utterance was created with', async () => {
    // run() starts on a later tick (and again on retry), so a speaker switch made after
    // synthesize() must not reach an utterance that already exists
    const geminiTts = new TTS({
      apiKey: 'k',
      model: 'gemini-3.8-flash-tts',
      speakers,
      speaker: 'Sienna',
    });
    const stream = geminiTts.synthesize('Sienna?');
    geminiTts.updateOptions({ speaker: 'Comanchero' });
    for await (const _frame of stream) {
      // drain
    }
    expect(sentContents()).toEqual([
      { role: 'user', parts: [{ text: '"Sienna?"', speech_metadata: { speaker: 'Sienna' } }] },
    ]);
  });

  it('sends speaker and style together', async () => {
    await synthesize(
      new TTS({ apiKey: 'k', model: 'gemini-3.8-flash-lite-tts', speakers, speaker: 'Sienna' }),
      '<expr type="expression" label="Wistful"/> Sienna?',
    );
    expect(sentContents()).toEqual([
      {
        role: 'user',
        parts: [{ text: '"Sienna?"', speech_metadata: { style: 'Wistful', speaker: 'Sienna' } }],
      },
    ]);
  });
});

function buildResponseChunk(data: Buffer) {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                data: data.toString('base64'),
                mimeType: 'audio/pcm',
              },
            },
          ],
        },
      },
    ],
  };
}
