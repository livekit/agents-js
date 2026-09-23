// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import type * as types from '@google/genai';
import { GoogleGenAI } from '@google/genai';
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  isAPIError,
  shortuuid,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { GeminiTTSModels } from '../models.js';

export type { GeminiTTSModels } from '../models.js';

export type GeminiVoices =
  | 'Zephyr'
  | 'Puck'
  | 'Charon'
  | 'Kore'
  | 'Fenrir'
  | 'Leda'
  | 'Orus'
  | 'Aoede'
  | 'Callirrhoe'
  | 'Autonoe'
  | 'Enceladus'
  | 'Iapetus'
  | 'Umbriel'
  | 'Algieba'
  | 'Despina'
  | 'Erinome'
  | 'Algenib'
  | 'Rasalgethi'
  | 'Laomedeia'
  | 'Achernar'
  | 'Alnilam'
  | 'Schedar'
  | 'Gacrux'
  | 'Pulcherrima'
  | 'Achird'
  | 'Zubenelgenubi'
  | 'Vindemiatrix'
  | 'Sadachbia'
  | 'Sadaltager'
  | 'Sulafat';

const DEFAULT_MODEL: GeminiTTSModels = 'gemini-3.1-flash-tts-preview';
const DEFAULT_VOICE: GeminiVoices = 'Kore';
const DEFAULT_SAMPLE_RATE = 24000; // not configurable
const NUM_CHANNELS = 1;
const DEFAULT_INSTRUCTIONS = "Say the text with a proper tone, don't omit or add any words";

// Models taking a per-part `speech_metadata.style` instead of one prompt-wide instruction.
// Substring-matched, so a dated build of either counts. The list stays narrow — gemini-3.1
// and 2.5 reject the field outright ("Speech metadata is not supported for this model"),
// and an unlisted model quietly loses its styles while a wrongly listed one fails every
// request.
const STYLE_METADATA_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];

/** Whether `model` accepts a delivery style on each part of the request. */
function stylesPerPart(model: string): boolean {
  return STYLE_METADATA_MODELS.some((family) => model.includes(family));
}

// Headerless PCM, asked for explicitly: the byte stream is decoded as raw PCM, and the docs
// only guarantee a headerless stream when response_format names it. The docs spell it
// "audio/l16"; on the wire it is an enum (AUDIO_MULAW and AUDIO_ALAW are the other two)
// nested under a ResponseFormatConfig that the typed SDK has no field for.
const RESPONSE_FORMAT = { audio: { mime_type: 'AUDIO_L16' } };

// where one part ends and the next begins: Gemini takes a style per part, and an
// expression marker is the only thing that changes it
const EXPRESSION_MARKER_RE = /<expr\b(?=[^>]*type="expression")[^>]*?\/\s*>/g;

export interface TTSOptions {
  model: GeminiTTSModels | string;
  voiceName: GeminiVoices | string;
  vertexai: boolean;
  project?: string;
  location?: string;
  instructions?: string;
  customPronunciations?: CustomPronunciations;
  /**
   * Speaker name to voice, for a multi-speaker voice config. Replaces `voiceName`. Needs a
   * model that takes per-part speech metadata (the gemini-3.8 family).
   */
  speakers?: Record<string, GeminiVoices | string>;
  /**
   * Which of `speakers` this instance voices. Required with `speakers`, and switchable via
   * `updateOptions`.
   */
  speaker?: string;
}

export interface CustomPronunciationParams {
  phrase: string;
  pronunciation: string;
  phoneticEncoding?: string;
}

export interface CustomPronunciations {
  pronunciations: CustomPronunciationParams[];
}

export class TTS extends tts.TTS {
  #opts: TTSOptions;
  #client: GoogleGenAI;
  label = 'google.gemini.TTS';

  /**
   * Create a new instance of Gemini TTS.
   *
   * Environment Requirements:
   * - For VertexAI: Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to the path of the service account key file.
   * - For Google Gemini API: Set the `apiKey` argument or the `GOOGLE_API_KEY` environment variable.
   *
   * @param opts - Configuration options for Gemini TTS
   */
  constructor({
    model = DEFAULT_MODEL,
    voiceName = DEFAULT_VOICE,
    apiKey,
    vertexai,
    project,
    location,
    instructions,
    customPronunciations,
    speakers,
    speaker,
  }: Partial<TTSOptions & { apiKey: string }> = {}) {
    super(DEFAULT_SAMPLE_RATE, NUM_CHANNELS, { streaming: false });

    const gcpProject: string | undefined = project || process.env.GOOGLE_CLOUD_PROJECT;
    const gcpLocation: string | undefined =
      location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    const useVertexai = vertexai ?? process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true';
    const geminiApiKey = apiKey || process.env.GOOGLE_API_KEY;

    let finalProject: string | undefined = gcpProject;
    let finalLocation: string | undefined = gcpLocation;
    let finalApiKey: string | undefined = geminiApiKey;

    if (useVertexai) {
      if (!finalProject) {
        throw new APIConnectionError({
          message:
            'Project ID is required for Vertex AI. Set via project option or GOOGLE_CLOUD_PROJECT environment variable',
        });
      }
      finalApiKey = undefined;
    } else {
      finalProject = undefined;
      finalLocation = undefined;
      if (!finalApiKey) {
        throw new APIConnectionError({
          message:
            'API key is required for Google API either via apiKey or GOOGLE_API_KEY environment variable',
        });
      }
    }

    const speakerMap = speakers ? { ...speakers } : undefined;
    if (speakerMap) {
      const count = Object.keys(speakerMap).length;
      // not "up to two": the API rejects any other count outright, with
      // "the number of speaker_voice_configs must equal 2"
      if (count !== 2) {
        throw new Error(`\`speakers\` must name exactly 2 speakers, got ${count}`);
      }
      // the API rejects a multi-speaker turn whose speech_metadata names no speaker, so
      // there is no useful default to fall back to here
      if (speaker === undefined) {
        throw new Error('`speaker` is required when `speakers` is set');
      }
      assertKnownSpeaker(speaker, speakerMap);
      if (!stylesPerPart(model)) {
        throw new Error(
          `multi-speaker needs a model that takes per-part speech_metadata; '${model}' does not`,
        );
      }
    }

    this.#opts = {
      model,
      voiceName,
      vertexai: useVertexai,
      project: finalProject,
      location: finalLocation,
      // this family speaks anything left in a part's text, so the preamble would be read
      // aloud (measured: it roughly triples a short line). styledParts puts instructions in
      // speech_metadata.style instead.
      instructions: instructions ?? (stylesPerPart(model) ? undefined : DEFAULT_INSTRUCTIONS),
      customPronunciations,
      speakers: speakerMap,
      speaker: speakerMap ? speaker : undefined,
    };

    const clientOptions: types.GoogleGenAIOptions = useVertexai
      ? {
          vertexai: true,
          project: finalProject,
          location: finalLocation,
        }
      : {
          apiKey: finalApiKey,
        };

    this.#client = new GoogleGenAI(clientOptions);
  }

  // only a model that can carry a style out of band declares the dialect; on the others a
  // marker would have nowhere to go and would be read aloud
  protected override markupProviderKey(): string {
    return stylesPerPart(this.#opts.model) ? 'gemini' : '';
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): ChunkedStream {
    return new ChunkedStream(text, this, connOptions, abortSignal);
  }

  /**
   * Update the TTS options.
   *
   * @param opts - Options to update
   */
  updateOptions(opts: { voiceName?: GeminiVoices | string; speaker?: string }) {
    if (opts.voiceName !== undefined) {
      this.#opts.voiceName = opts.voiceName;
    }
    if (opts.speaker !== undefined) {
      if (!this.#opts.speakers) {
        throw new Error('`speaker` needs a TTS constructed with `speakers`');
      }
      assertKnownSpeaker(opts.speaker, this.#opts.speakers);
      this.#opts.speaker = opts.speaker;
    }
  }

  stream(): tts.SynthesizeStream {
    throw new Error('Streaming is not supported on Gemini TTS');
  }

  get opts(): TTSOptions {
    return this.#opts;
  }

  get client(): GoogleGenAI {
    return this.#client;
  }
}

export class ChunkedStream extends tts.ChunkedStream {
  #tts: TTS;
  #opts: TTSOptions;
  label = 'google.gemini.ChunkedStream';

  constructor(
    inputText: string,
    tts: TTS,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(inputText, tts, connOptions, abortSignal);
    this.#tts = tts;
    // Snapshot the options now: run() starts on a later tick and runs again on every retry,
    // so reading the shared options there would let a later updateOptions() (a speaker
    // switch) change an utterance that was already created.
    this.#opts = snapshotOptions(tts.opts);
  }

  protected async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#tts.sampleRate, this.#tts.numChannels);

    const opts = this.#opts;
    const config: types.GenerateContentConfig = {
      responseModalities: ['AUDIO'],
      speechConfig: speechConfig(opts),
      abortSignal: this.abortSignal,
    };

    let inputText = this.inputText;
    const instructions = [opts.instructions, formatCustomPronunciations(opts.customPronunciations)]
      .filter((instruction): instruction is string => !!instruction)
      .join('\n');

    // neither speech_metadata nor response_format has a field on the typed config, so both
    // ride extraBody: it merges into the request body, replacing `contents` wholesale since
    // arrays overwrite, and merging into `generationConfig` since objects recurse.
    const extraBody: Record<string, unknown> = {};
    if (stylesPerPart(opts.model)) {
      extraBody.generationConfig = { response_format: RESPONSE_FORMAT };
    }
    const styledParts = this.#styledParts(instructions);
    if (styledParts) {
      extraBody.contents = [{ role: 'user', parts: styledParts }];
    } else if (instructions) {
      inputText = `${instructions}:\n"${inputText}"`;
    }
    if (Object.keys(extraBody).length) {
      config.httpOptions = { extraBody };
    }

    const contents: types.Content[] = [
      {
        role: 'user',
        parts: [{ text: inputText }],
      },
    ];

    try {
      let lastFrame: AudioFrame | undefined;
      const sendLastFrame = (final: boolean) => {
        if (lastFrame) {
          this.queue.put({
            requestId,
            frame: lastFrame,
            segmentId: requestId,
            final,
          });
          lastFrame = undefined;
        }
      };

      const responseStream = await this.#tts.client.models.generateContentStream({
        model: opts.model,
        contents,
        config,
      });

      for await (const response of responseStream) {
        await this.#processResponse(response, bstream, (frame) => {
          sendLastFrame(false);
          lastFrame = frame;
        });
      }

      for (const frame of bstream.flush()) {
        sendLastFrame(false);
        lastFrame = frame;
      }

      sendLastFrame(true);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      if (isAPIError(error)) throw error;

      const err = error as {
        code?: number;
        message?: string;
        status?: string;
        type?: string;
      };

      if (err.code && err.code >= 400 && err.code < 500) {
        if (err.code === 429) {
          throw new APIStatusError({
            message: `Gemini TTS: Rate limit error - ${err.message || 'Unknown error'}`,
            options: {
              statusCode: 429,
              retryable: true,
            },
          });
        } else {
          throw new APIStatusError({
            message: `Gemini TTS: Client error (${err.code}) - ${err.message || 'Unknown error'}`,
            options: {
              statusCode: err.code,
              retryable: false,
            },
          });
        }
      }

      if (err.code && err.code >= 500) {
        throw new APIStatusError({
          message: `Gemini TTS: Server error (${err.code}) - ${err.message || 'Unknown error'}`,
          options: {
            statusCode: err.code,
            retryable: true,
          },
        });
      }

      throw new APIConnectionError({
        message: `Gemini TTS: Connection error - ${err.message || 'Unknown error'}`,
        options: { retryable: true },
      });
    } finally {
      this.queue.close();
    }
  }

  /**
   * Build one request part per delivery style, or `undefined` if none is carried.
   *
   * Discrete events are already inline Gemini tags here (`convert` lowered them) and belong
   * in the words; the `expression` marker is the other channel and comes out, splitting the
   * text wherever the delivery changes:
   *
   * ```
   * {"parts": [{"text": "\"<chuckle> Sienna?\"",
   *             "speech_metadata": {"style": "Thoughtful, Quiet"}},
   *            {"text": "\"What's on your mind?\"",
   *             "speech_metadata": {"style": "Wistful"}}]}
   * ```
   *
   * The agent's stream adapter hands over one sentence at a time, so a turn usually makes
   * one part; a direct `synthesize()` call may carry several sentences, and each keeps the
   * style that governs it — including a leading one with no style of its own, which travels
   * as a plain part. Hence `splitExprMarkup`, not `splitAllMarkup` — the latter would take
   * the inline tags out too.
   */
  #styledParts(instructions: string): Record<string, unknown>[] | undefined {
    const opts = this.#opts;
    if (!stylesPerPart(opts.model)) {
      return undefined;
    }

    const markup = this.#tts.markup;
    // the stream adapter has already lowered; a direct synthesize() call has not
    const text = markup.convert(markup.normalize(this.inputText));
    // slice at each marker, keeping it at the head of its span so the shared splitter reads
    // the label off it
    const bounds = [
      0,
      ...Array.from(text.matchAll(EXPRESSION_MARKER_RE), (m) => m.index),
      text.length,
    ];

    const parts: Record<string, unknown>[] = [];
    let strippedAMarker = false;
    for (let i = 0; i + 1 < bounds.length; i++) {
      const [clean, markers] = tts.splitExprMarkup(text.slice(bounds[i], bounds[i + 1]));
      const expressions = markers.filter((t) => t.type === 'expression');
      strippedAMarker ||= expressions.length > 0;
      const words = clean.trim();
      if (!words) continue;

      const part: Record<string, unknown> = { text: `"${words}"` };
      const metadata: Record<string, string> = {};
      const style = [instructions, expressions[0]?.value].filter((p) => !!p).join(', ');
      if (style) {
        metadata.style = style;
      }
      if (opts.speaker) {
        // every turn of a multi-speaker request has to name its speaker, so a part carries
        // one even with no style of its own
        metadata.speaker = opts.speaker;
      }
      if (Object.keys(metadata).length) {
        part.speech_metadata = metadata;
      }
      parts.push(part);
    }

    // a span with no direction is still a part: dropping the whole request over it would
    // send the raw text, markers and all, for Gemini to read out. Only hand back undefined
    // when nothing has to travel out of band at all.
    if (!parts.length || !(strippedAMarker || parts.some((p) => 'speech_metadata' in p))) {
      return undefined;
    }
    return parts;
  }

  async #processResponse(
    response: types.GenerateContentResponse,
    bstream: AudioByteStream,
    onFrame: (frame: AudioFrame) => void,
  ) {
    if (!response.candidates || response.candidates.length === 0) {
      return;
    }

    const candidate = response.candidates[0];
    if (!candidate || !candidate.content?.parts) {
      return;
    }

    for (const part of candidate.content.parts) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) {
        const audioBuffer = Buffer.from(part.inlineData.data, 'base64');

        for (const frame of bstream.write(audioBuffer)) {
          onFrame(frame);
        }
      }
    }
  }
}

/** A copy of `opts` that later option updates can't reach, nested tables included. */
function snapshotOptions(opts: TTSOptions): TTSOptions {
  return {
    ...opts,
    speakers: opts.speakers ? { ...opts.speakers } : undefined,
    customPronunciations: opts.customPronunciations
      ? {
          pronunciations: opts.customPronunciations.pronunciations.map((p) => ({ ...p })),
        }
      : undefined,
  };
}

/** One voice, or a speaker-to-voice table when the TTS was given `speakers`. */
function speechConfig(opts: TTSOptions): types.SpeechConfig {
  if (opts.speakers) {
    return {
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: Object.entries(opts.speakers).map(([speaker, voiceName]) => ({
          speaker,
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        })),
      },
    };
  }
  return { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voiceName } } };
}

function assertKnownSpeaker(speaker: string, speakers: Record<string, string>): void {
  if (!(speaker in speakers)) {
    throw new Error(
      `speaker '${speaker}' is not one of the configured speakers: ` +
        Object.keys(speakers).sort().join(', '),
    );
  }
}

function formatCustomPronunciations(
  customPronunciations?: CustomPronunciations,
): string | undefined {
  if (!customPronunciations?.pronunciations.length) {
    return undefined;
  }

  const rules = customPronunciations.pronunciations.map((pronunciation) => {
    const encoding = pronunciation.phoneticEncoding
      ? ` using ${pronunciation.phoneticEncoding}`
      : '';
    return `- Pronounce "${pronunciation.phrase}" as "${pronunciation.pronunciation}"${encoding}`;
  });

  return ['Use these custom pronunciations when speaking the text:', ...rules].join('\n');
}
