import { GoogleGenAI } from "@google/genai";
import {
  APIConnectionError,
  APIStatusError,
  AudioByteStream,
  isAPIError,
  shortuuid,
  tts
} from "@livekit/agents";
const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";
const DEFAULT_VOICE = "Kore";
const DEFAULT_SAMPLE_RATE = 24e3;
const NUM_CHANNELS = 1;
const DEFAULT_INSTRUCTIONS = "Say the text with a proper tone, don't omit or add any words";
class TTS extends tts.TTS {
  #opts;
  #client;
  label = "google.gemini.TTS";
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
    instructions
  } = {}) {
    super(DEFAULT_SAMPLE_RATE, NUM_CHANNELS, { streaming: false });
    const gcpProject = project || process.env.GOOGLE_CLOUD_PROJECT;
    const gcpLocation = location || process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
    const useVertexai = vertexai ?? process.env.GOOGLE_GENAI_USE_VERTEXAI === "true";
    const geminiApiKey = apiKey || process.env.GOOGLE_API_KEY;
    let finalProject = gcpProject;
    let finalLocation = gcpLocation;
    let finalApiKey = geminiApiKey;
    if (useVertexai) {
      if (!finalProject) {
        throw new APIConnectionError({
          message: "Project ID is required for Vertex AI. Set via project option or GOOGLE_CLOUD_PROJECT environment variable"
        });
      }
      finalApiKey = void 0;
    } else {
      finalProject = void 0;
      finalLocation = void 0;
      if (!finalApiKey) {
        throw new APIConnectionError({
          message: "API key is required for Google API either via apiKey or GOOGLE_API_KEY environment variable"
        });
      }
    }
    this.#opts = {
      model,
      voiceName,
      vertexai: useVertexai,
      project: finalProject,
      location: finalLocation,
      instructions: instructions ?? DEFAULT_INSTRUCTIONS
    };
    const clientOptions = useVertexai ? {
      vertexai: true,
      project: finalProject,
      location: finalLocation
    } : {
      apiKey: finalApiKey
    };
    this.#client = new GoogleGenAI(clientOptions);
  }
  synthesize(text, connOptions, abortSignal) {
    return new ChunkedStream(text, this, connOptions, abortSignal);
  }
  /**
   * Update the TTS options.
   *
   * @param opts - Options to update
   */
  updateOptions(opts) {
    if (opts.voiceName !== void 0) {
      this.#opts.voiceName = opts.voiceName;
    }
  }
  stream() {
    throw new Error("Streaming is not supported on Gemini TTS");
  }
  get opts() {
    return this.#opts;
  }
  get client() {
    return this.#client;
  }
}
class ChunkedStream extends tts.ChunkedStream {
  #tts;
  label = "google.gemini.ChunkedStream";
  constructor(inputText, tts2, connOptions, abortSignal) {
    super(inputText, tts2, connOptions, abortSignal);
    this.#tts = tts2;
  }
  async run() {
    const requestId = shortuuid();
    const bstream = new AudioByteStream(this.#tts.sampleRate, this.#tts.numChannels);
    const config = {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: this.#tts.opts.voiceName
          }
        }
      },
      abortSignal: this.abortSignal
    };
    let inputText = this.inputText;
    if (this.#tts.opts.instructions) {
      inputText = `${this.#tts.opts.instructions}:
"${inputText}"`;
    }
    const contents = [
      {
        role: "user",
        parts: [{ text: inputText }]
      }
    ];
    const responseStream = await this.#tts.client.models.generateContentStream({
      model: this.#tts.opts.model,
      contents,
      config
    });
    try {
      for await (const response of responseStream) {
        await this.#processResponse(response, bstream, requestId);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      if (isAPIError(error)) throw error;
      const err = error;
      if (err.code && err.code >= 400 && err.code < 500) {
        if (err.code === 429) {
          throw new APIStatusError({
            message: `Gemini TTS: Rate limit error - ${err.message || "Unknown error"}`,
            options: {
              statusCode: 429,
              retryable: true
            }
          });
        } else {
          throw new APIStatusError({
            message: `Gemini TTS: Client error (${err.code}) - ${err.message || "Unknown error"}`,
            options: {
              statusCode: err.code,
              retryable: false
            }
          });
        }
      }
      if (err.code && err.code >= 500) {
        throw new APIStatusError({
          message: `Gemini TTS: Server error (${err.code}) - ${err.message || "Unknown error"}`,
          options: {
            statusCode: err.code,
            retryable: true
          }
        });
      }
      throw new APIConnectionError({
        message: `Gemini TTS: Connection error - ${err.message || "Unknown error"}`,
        options: { retryable: true }
      });
    } finally {
      this.queue.close();
    }
  }
  async #processResponse(response, bstream, requestId) {
    var _a, _b, _c;
    if (!response.candidates || response.candidates.length === 0) {
      return;
    }
    const candidate = response.candidates[0];
    if (!candidate || !((_a = candidate.content) == null ? void 0 : _a.parts)) {
      return;
    }
    let lastFrame;
    const sendLastFrame = (final) => {
      if (lastFrame) {
        this.queue.put({
          requestId,
          frame: lastFrame,
          segmentId: requestId,
          final
        });
        lastFrame = void 0;
      }
    };
    for (const part of candidate.content.parts) {
      if (((_b = part.inlineData) == null ? void 0 : _b.data) && ((_c = part.inlineData.mimeType) == null ? void 0 : _c.startsWith("audio/"))) {
        const audioBuffer = Buffer.from(part.inlineData.data, "base64");
        for (const frame of bstream.write(audioBuffer)) {
          sendLastFrame(false);
          lastFrame = frame;
        }
      }
    }
    for (const frame of bstream.flush()) {
      sendLastFrame(false);
      lastFrame = frame;
    }
    sendLastFrame(true);
  }
}
export {
  ChunkedStream,
  TTS
};
//# sourceMappingURL=gemini_tts.js.map